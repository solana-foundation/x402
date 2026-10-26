"""SVM facilitator implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import random
from typing import Any

try:
    from solders.pubkey import Pubkey
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ....pending_settlement_store import InMemoryPendingSettlementStore, PendingSettlementStore
from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_ALT_RESOLUTION_NOT_AVAILABLE,
    ERR_AMOUNT_INSUFFICIENT,
    ERR_AMOUNT_MISMATCH,
    ERR_COMPUTE_PRICE_TOO_HIGH,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_FEE_PAYER_MISSING,
    ERR_FEE_PAYER_NOT_MANAGED,
    ERR_FEE_PAYER_TRANSFERRING,
    ERR_INVALID_COMPUTE_LIMIT,
    ERR_INVALID_COMPUTE_PRICE,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_MEMO_COUNT,
    ERR_MEMO_MISMATCH,
    ERR_MINT_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_RECIPIENT_MISMATCH,
    ERR_SETTLEMENT_PENDING,
    ERR_SIMULATION_FAILED,
    ERR_SPLIT_AUTHORITY_MISMATCH,
    ERR_SPLIT_LEG_UNMATCHED,
    ERR_TRANSACTION_DECODE_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_UNKNOWN_FIFTH_INSTRUCTION,
    ERR_UNKNOWN_FOURTH_INSTRUCTION,
    ERR_UNKNOWN_OPTIONAL_INSTRUCTION,
    ERR_UNKNOWN_SIXTH_INSTRUCTION,
    ERR_UNSUPPORTED_SCHEME,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_SPLITS,
    MEMO_PROGRAM_ADDRESS,
    SCHEME_EXACT,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)
from ..settlement_cache import SettlementCache
from ..signer import FacilitatorSvmSigner
from ..types import ExactSvmPayload
from ..utils import (
    decode_transaction_from_payload,
    derive_ata,
    get_token_payer_from_transaction,
    transaction_message_hash,
)
from .splits import (
    InstructionView,
    PaymentLeg,
    SplitCapabilities,
    SplitsError,
    assert_fee_payer_isolated_with_ata_creation,
    assert_within_capabilities,
    is_ata_program_instruction,
    parse_payment_legs,
    uses_split_terms,
)

_TRANSFER_PROGRAMS = (TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS)
_OPTIONAL_PROGRAMS = (LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS)


def _compute_budget_error(
    limit_program: str, limit_data: bytes, price_program: str, price_data: bytes
) -> str | None:
    """Check the SetComputeUnitLimit / SetComputeUnitPrice pair at indexes 0 and 1.

    Returns:
        An error reason, or None when both instructions are valid.
    """
    if (
        limit_program != COMPUTE_BUDGET_PROGRAM_ADDRESS
        or len(limit_data) < 1
        or limit_data[0] != 2  # SetComputeUnitLimit discriminator
    ):
        return ERR_INVALID_COMPUTE_LIMIT
    if (
        price_program != COMPUTE_BUDGET_PROGRAM_ADDRESS
        or len(price_data) < 9
        or price_data[0] != 3  # SetComputeUnitPrice discriminator
    ):
        return ERR_INVALID_COMPUTE_PRICE
    # Parse microLamports (u64, little-endian) and check against max
    if int.from_bytes(price_data[1:9], "little") > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS:
        return ERR_COMPUTE_PRICE_TOO_HIGH
    return None


def _expected_memo_error(
    optional_instructions: list[InstructionView], extra: dict[str, Any]
) -> str | None:
    """Check that exactly one Memo instruction carries ``extra.memo`` when set.

    Returns:
        An error reason, or None when the memo is valid.
    """
    expected_memo = extra.get("memo")
    if not expected_memo or not isinstance(expected_memo, str):
        return None
    memo_ixs = [ix for ix in optional_instructions if ix.program == MEMO_PROGRAM_ADDRESS]
    if len(memo_ixs) != 1:
        return ERR_MEMO_COUNT
    try:
        actual_memo = memo_ixs[0].data.decode("utf-8")
    except UnicodeDecodeError:
        return ERR_MEMO_MISMATCH
    return None if actual_memo == expected_memo else ERR_MEMO_MISMATCH


class ExactSvmScheme:
    """SVM facilitator implementation for the Exact payment scheme (V2).

    Verifies and settles SPL token payments on Solana networks.

    Attributes:
        scheme: The scheme identifier ("exact").
        caip_family: The CAIP family pattern ("solana:*").
    """

    scheme = SCHEME_EXACT
    caip_family = "solana:*"

    def __init__(
        self,
        signer: FacilitatorSvmSigner,
        settlement_cache: SettlementCache | None = None,
        pending_store: PendingSettlementStore | None = None,
        max_splits: int = 0,
        ata_creation_sponsored: bool = False,
    ):
        """Create ExactSvmScheme facilitator.

        Args:
            signer: SVM signer for verification and settlement.
            settlement_cache: Optional shared settlement cache (one is created if omitted).
            pending_store: Optional store letting a retried settle for the same
                transaction reconcile against an already-broadcast signature instead of
                re-verifying and re-sending (see settlement_pending). Defaults to a fresh
                in-memory store when omitted.
            max_splits: Maximum number of ``extra.splits`` entries accepted
                (scheme_exact_svm.md §5), 0-8. Advertised as ``maxSplits`` in
                ``/supported``; requirements with more splits are rejected with
                ``split_count_exceeded``. Default 0: splits are not accepted.
            ata_creation_sponsored: Whether the fee payer funds
                ``CreateIdempotent`` for recipients marked
                ``ataCreationRequired`` (about 0.002 SOL of rent each).
                Advertised as ``ataCreationSponsored``. Rent is not bounded over
                time: an owner can close its ATA and the next charge pays again,
                so operators enabling this should rate-limit or price sponsored
                creations. Default False.

        Raises:
            ValueError: If max_splits is not an int in 0-8.
        """
        if (
            not isinstance(max_splits, int)
            or isinstance(max_splits, bool)
            or not 0 <= max_splits <= MAX_SPLITS
        ):
            raise ValueError(
                f"max_splits must be an integer from 0 to {MAX_SPLITS}, received {max_splits!r}"
            )
        self._max_splits = max_splits
        self._ata_creation_sponsored = ata_creation_sponsored is True
        self._signer = signer
        self._settlement_cache = settlement_cache or SettlementCache()
        self._pending_store: PendingSettlementStore = (
            pending_store or InMemoryPendingSettlementStore()
        )

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get mechanism-specific extra data for the supported kinds endpoint.

        For SVM, this includes a randomly selected fee payer address.
        Random selection distributes load across multiple signers.

        Args:
            network: Network identifier (unused for SVM).

        Returns:
            Extra data with feePayer address.
        """
        _ = network  # Unused
        # Randomly select from available signers to distribute load
        addresses = self._signer.get_addresses()
        fee_payer = random.choice(addresses)

        extra: dict[str, Any] = {"feePayer": fee_payer}
        # Split capabilities fail closed: absent keys mean no support (§5.5).
        if self._max_splits > 0:
            extra["maxSplits"] = self._max_splits
        if self._ata_creation_sponsored:
            extra["ataCreationSponsored"] = True
        return extra

    def get_signers(self, network: Network) -> list[str]:
        """Get facilitator wallet addresses.

        Args:
            network: Network identifier.

        Returns:
            List of facilitator fee payer addresses.
        """
        _ = network  # Unused
        return list(self._signer.get_addresses())

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        """Verify SPL token payment payload.

        Validates:
        - Scheme and network match
        - Transaction structure (3-6 instructions)
        - Compute budget instructions are valid
        - TransferChecked instruction:
          - Token program is known (Token or Token-2022)
          - Mint matches requirements.asset
          - Destination ATA matches requirements.pay_to
        - Amount >= requirements.amount
          - Authority is not the facilitator (prevent self-transfer)
        - Simulates transaction to catch runtime errors

        Args:
            payload: Payment payload from client.
            requirements: Payment requirements.

        Returns:
            VerifyResponse with is_valid and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = str(requirements.network)

        # Step 1: Validate Payment Requirements
        if payload.accepted.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer="")

        if str(payload.accepted.network) != str(requirements.network):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer="")

        extra = requirements.extra or {}
        fee_payer_str = extra.get("feePayer")
        if not fee_payer_str or not isinstance(fee_payer_str, str):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_FEE_PAYER_MISSING, payer="")

        # Verify that the requested feePayer is managed by this facilitator
        signer_addresses = self._signer.get_addresses()
        if fee_payer_str not in signer_addresses:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_FEE_PAYER_NOT_MANAGED, payer=""
            )

        # Splits (§5): validate the terms and check them against what this
        # facilitator advertises before looking at the transaction.
        legs: list[PaymentLeg] | None = None
        if uses_split_terms(requirements):
            try:
                legs = parse_payment_legs(requirements)
                assert_within_capabilities(
                    legs,
                    SplitCapabilities(
                        max_splits=self._max_splits,
                        ata_creation_sponsored=self._ata_creation_sponsored,
                    ),
                )
            except SplitsError as e:
                return VerifyResponse(
                    is_valid=False, invalid_reason=e.reason, invalid_message=str(e), payer=""
                )

        # Step 2: Parse and Validate Transaction Structure
        try:
            tx = decode_transaction_from_payload(svm_payload)
        except Exception:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_TRANSACTION_DECODE_FAILED, payer=""
            )

        if legs is not None:
            return self._verify_static_split_path(
                tx, svm_payload.transaction, requirements, signer_addresses, legs, fee_payer_str
            )

        message = tx.message
        instructions = message.instructions
        static_accounts = list(message.account_keys)

        # 3-6 instructions: ComputeLimit + ComputePrice + TransferChecked + optional Lighthouse/Memo
        if len(instructions) < 3 or len(instructions) > 6:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INVALID_INSTRUCTION_COUNT, payer=""
            )

        # Step 3: Verify Compute Budget Instructions (indexes 0 and 1)
        compute_budget_error = _compute_budget_error(
            str(static_accounts[instructions[0].program_id_index]),
            bytes(instructions[0].data),
            str(static_accounts[instructions[1].program_id_index]),
            bytes(instructions[1].data),
        )
        if compute_budget_error:
            return VerifyResponse(is_valid=False, invalid_reason=compute_budget_error, payer="")

        # Get token payer
        payer = get_token_payer_from_transaction(tx)
        if not payer:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=""
            )

        # Step 4: Verify Transfer Instruction
        transfer_ix = instructions[2]
        transfer_program = static_accounts[transfer_ix.program_id_index]
        transfer_program_str = str(transfer_program)

        token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)

        if transfer_program != token_program and transfer_program != token_2022_program:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

        # Step 5: Verify optional instructions (if present)
        optional_instructions = instructions[3:]
        if optional_instructions:
            lighthouse_program = Pubkey.from_string(LIGHTHOUSE_PROGRAM_ADDRESS)
            memo_program = Pubkey.from_string(MEMO_PROGRAM_ADDRESS)
            invalid_reasons = [
                ERR_UNKNOWN_FOURTH_INSTRUCTION,
                ERR_UNKNOWN_FIFTH_INSTRUCTION,
                ERR_UNKNOWN_SIXTH_INSTRUCTION,
            ]

            for idx, optional_ix in enumerate(optional_instructions):
                optional_program = static_accounts[optional_ix.program_id_index]
                if optional_program in (lighthouse_program, memo_program):
                    continue

                reason = (
                    invalid_reasons[idx]
                    if idx < len(invalid_reasons)
                    else ERR_UNKNOWN_SIXTH_INSTRUCTION
                )
                return VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer)

        # Step 5b: Verify memo content matches extra.memo when present
        expected_memo = extra.get("memo")
        if expected_memo and isinstance(expected_memo, str):
            memo_program = Pubkey.from_string(MEMO_PROGRAM_ADDRESS)
            memo_ixs = [
                ix
                for ix in optional_instructions
                if static_accounts[ix.program_id_index] == memo_program
            ]
            if len(memo_ixs) != 1:
                return VerifyResponse(is_valid=False, invalid_reason=ERR_MEMO_COUNT, payer=payer)
            actual_memo = bytes(memo_ixs[0].data).decode("utf-8")
            if actual_memo != expected_memo:
                return VerifyResponse(is_valid=False, invalid_reason=ERR_MEMO_MISMATCH, payer=payer)

        # Parse transfer instruction
        transfer_accounts = list(transfer_ix.accounts)
        transfer_data = bytes(transfer_ix.data)

        # TransferChecked data: [12 (discriminator), u64 amount, u8 decimals]
        if len(transfer_data) < 10 or transfer_data[0] != 12:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

        # TransferChecked accounts: [source, mint, destination, owner]
        if len(transfer_accounts) < 4:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

        _source_ata = static_accounts[transfer_accounts[0]]  # noqa: F841
        mint = static_accounts[transfer_accounts[1]]
        dest_ata = static_accounts[transfer_accounts[2]]
        authority = static_accounts[transfer_accounts[3]]

        amount = int.from_bytes(transfer_data[1:9], "little")

        # Verify facilitator's signers are not transferring their own funds
        # SECURITY: Prevent facilitator from signing away their own tokens
        authority_str = str(authority)
        if authority_str in signer_addresses:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_FEE_PAYER_TRANSFERRING, payer=payer
            )

        # Verify mint address matches requirements
        mint_str = str(mint)
        if mint_str != requirements.asset:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_MINT_MISMATCH, payer=payer)

        # Verify destination ATA matches expected ATA for payTo address
        expected_dest_ata = derive_ata(
            requirements.pay_to, requirements.asset, transfer_program_str
        )
        if str(dest_ata) != expected_dest_ata:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer
            )

        # Verify transfer amount meets requirements
        required_amount = int(requirements.amount)
        if amount < required_amount:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_AMOUNT_INSUFFICIENT, payer=payer
            )

        # Step 5: Sign and Simulate Transaction
        # CRITICAL: Simulation proves transaction will succeed
        try:
            # Sign transaction with the feePayer's signer
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer_str, network
            )

            # Simulate to verify transaction would succeed
            self._signer.simulate_transaction(fully_signed_tx, network)
        except Exception as e:
            error_msg = str(e)
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_SIMULATION_FAILED,
                invalid_message=error_msg,
                payer=payer,
            )

        return VerifyResponse(is_valid=True, payer=payer)

    def _verify_static_split_path(
        self,
        tx: Any,
        tx_base64: str,
        requirements: PaymentRequirements,
        signer_addresses: list[str],
        legs: list[PaymentLeg],
        fee_payer: str,
    ) -> VerifyResponse:
        """Path 1 for split charges (scheme_exact_svm.md §5.7).

        Layout: compute limit, compute price, ``K`` fee-payer-funded
        CreateIdempotent for marked recipients, one TransferChecked for the
        primary remainder, one per split in ``extra.splits`` order, then up to
        four Lighthouse / Memo instructions. There is no simulation-based
        fallback in this SDK, so any layout failure is a rejection.
        """
        network = str(requirements.network)

        def fail(reason: str, payer: str = "", message: str | None = None) -> VerifyResponse:
            return VerifyResponse(
                is_valid=False, invalid_reason=reason, invalid_message=message, payer=payer
            )

        message = tx.message
        # Accounts loaded from lookup tables cannot be resolved here, and the
        # isolation check must see every account (§2.1.2).
        if getattr(message, "address_table_lookups", None):
            return fail(ERR_ALT_RESOLUTION_NOT_AVAILABLE)
        static_accounts = [str(key) for key in message.account_keys]
        instructions: list[InstructionView] = []
        for ix in message.instructions:
            indexes = [ix.program_id_index, *ix.accounts]
            if any(i >= len(static_accounts) for i in indexes):
                return fail(ERR_TRANSACTION_DECODE_FAILED)
            instructions.append(
                InstructionView(
                    program=static_accounts[ix.program_id_index],
                    accounts=[static_accounts[i] for i in ix.accounts],
                    data=bytes(ix.data),
                )
            )

        create_count = 0
        while 2 + create_count < len(instructions) and is_ata_program_instruction(
            instructions[2 + create_count]
        ):
            create_count += 1
        first_transfer = 2 + create_count
        first_optional = first_transfer + len(legs)
        if len(instructions) < first_optional or len(instructions) > first_optional + 4:
            return fail(ERR_INVALID_INSTRUCTION_COUNT)

        compute_budget_error = _compute_budget_error(
            instructions[0].program,
            instructions[0].data,
            instructions[1].program,
            instructions[1].data,
        )
        if compute_budget_error:
            return fail(compute_budget_error)

        # Positional transfers: the primary remainder, then each split in order.
        payer = ""
        token_program: str | None = None
        for i, leg in enumerate(legs):
            transfer_ix = instructions[first_transfer + i]
            # Exactly 10 data bytes and 4 accounts: trailing multisig signer
            # accounts would let the transfer's authority be something other
            # than the account the payer signed with.
            if (
                transfer_ix.program not in _TRANSFER_PROGRAMS
                or len(transfer_ix.data) != 10
                or transfer_ix.data[0] != 12  # TransferChecked discriminator
                or len(transfer_ix.accounts) != 4
            ):
                return fail(ERR_NO_TRANSFER_INSTRUCTION, payer)
            if token_program and transfer_ix.program != token_program:
                return fail(ERR_SPLIT_LEG_UNMATCHED, payer, "legs use different token programs")
            token_program = transfer_ix.program

            # TransferChecked accounts: [source, mint, destination, authority]
            _source, mint, destination, authority = transfer_ix.accounts
            if authority in signer_addresses:
                return fail(ERR_FEE_PAYER_TRANSFERRING, authority)
            if payer and authority != payer:
                return fail(ERR_SPLIT_AUTHORITY_MISMATCH, payer)
            payer = authority

            if mint != requirements.asset:
                return fail(ERR_MINT_MISMATCH, payer)
            if destination != derive_ata(leg.owner, requirements.asset, token_program):
                return fail(ERR_RECIPIENT_MISMATCH, payer)
            if int.from_bytes(transfer_ix.data[1:9], "little") != leg.amount:
                return fail(ERR_AMOUNT_MISMATCH, payer)

        optional_instructions = instructions[first_optional:]
        if any(ix.program not in _OPTIONAL_PROGRAMS for ix in optional_instructions):
            return fail(ERR_UNKNOWN_OPTIONAL_INSTRUCTION, payer)

        # Fee payer isolation with the bounded CreateIdempotent exception
        # (§2.1.1); this also validates every creation against §5.4.
        try:
            assert_fee_payer_isolated_with_ata_creation(
                instructions,
                fee_payer,
                asset=requirements.asset,
                marked_owners={leg.owner for leg in legs if leg.ata_creation_required},
                token_program=token_program,
            )
        except SplitsError as e:
            return fail(e.reason, payer, str(e))

        memo_error = _expected_memo_error(optional_instructions, requirements.extra or {})
        if memo_error:
            return fail(memo_error, payer)

        # Sign and simulate: simulation proves the transaction would succeed.
        try:
            fully_signed_tx = self._signer.sign_transaction(tx_base64, fee_payer, network)
            self._signer.simulate_transaction(fully_signed_tx, network)
        except Exception as e:
            return fail(ERR_SIMULATION_FAILED, payer, str(e))

        return VerifyResponse(is_valid=True, payer=payer)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Settle SPL token payment on-chain.

        - Re-verifies payment
        - Signs transaction with fee payer
        - Sends transaction to network
        - Waits for confirmation

        Args:
            payload: Verified payment payload.
            requirements: Payment requirements.

        Returns:
            SettleResponse with success, transaction, and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = str(payload.accepted.network)

        # Parse and decode the transaction up front (no RPC calls) so we can key the
        # PendingSettlementStore on the message hash before doing any verify/sign/send work.
        try:
            tx = decode_transaction_from_payload(svm_payload)
            tx_key = transaction_message_hash(tx)
        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_DECODE_FAILED,
                error_message=str(e),
                network=network,
                payer="",
                transaction="",
            )

        # Pending-settlement fast path: a prior settle for this exact transaction
        # broadcast successfully but its confirm_transaction wait failed. Reconcile
        # against the already-broadcast signature instead of re-verifying and
        # re-sending: Solana transactions embed a recent blockhash that expires (so a
        # resend can fail even when the original is still perfectly valid), and if the
        # original actually did land, a second verify's balance-based simulation could
        # now spuriously fail (funds already moved).
        cached_signature = self._pending_store.get(tx_key)
        if cached_signature is not None:
            # Remove before reconciling (rather than after) so a concurrent
            # retry of the same payload misses here instead of also
            # reconciling: it falls through to the settlement_cache dedup
            # check below, which independently rejects it as a duplicate.
            self._pending_store.delete(tx_key)
            # Best-effort payer for the response; a lookup failure here doesn't block
            # reconciliation (the payload already broadcast successfully).
            try:
                payer = get_token_payer_from_transaction(tx) or ""
            except Exception:
                payer = ""
            return self._reconcile_pending_settlement(tx_key, cached_signature, payer, network)

        # First verify
        verify_result = self.verify(payload, requirements, context)
        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                network=network,
                payer=verify_result.payer,
                transaction="",
            )

        # Duplicate settlement check keyed on message hash (immune to mutable fee-payer sig at slot 0).
        if self._settlement_cache.is_duplicate(tx_key):
            return SettleResponse(
                success=False,
                error_reason=ERR_DUPLICATE_SETTLEMENT,
                network=network,
                payer=verify_result.payer or "",
                transaction="",
            )

        try:
            # Extract feePayer from requirements (already validated in verify)
            extra = requirements.extra or {}
            fee_payer = extra["feePayer"]

            # Sign transaction with the feePayer's signer
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer, network
            )
        except Exception as e:
            self._settlement_cache.delete(tx_key)
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction="",
                network=network,
                payer=verify_result.payer or "",
            )

        try:
            # Send transaction to network
            signature = self._signer.send_transaction(fully_signed_tx, network)
        except Exception as e:
            self._settlement_cache.delete(tx_key)
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction="",
                network=network,
                payer=verify_result.payer or "",
            )

        # Wait for confirmation, shared with the pending-settlement reconciliation
        # path in _reconcile_pending_settlement() below.
        return self._await_confirmation(tx_key, signature, verify_result.payer or "", network)

    def _reconcile_pending_settlement(
        self,
        tx_key: str,
        signature: str,
        payer: str,
        network: str,
    ) -> SettleResponse:
        """Handle a PendingSettlementStore cache hit.

        A prior settle call for this transaction (keyed by tx_key, the message hash)
        already broadcast `signature` but couldn't confirm it before returning
        settlement_pending. Re-awaits confirmation of that same signature rather than
        re-verifying/re-signing/re-sending — see the fast-path comment in settle() for
        why re-sending is unsafe here.
        """
        return self._await_confirmation(tx_key, signature, payer, network)

    def _await_confirmation(
        self,
        tx_key: str,
        signature: str,
        payer: str,
        network: str,
    ) -> SettleResponse:
        """Waits for confirmation of an already-broadcast signature and builds the
        settle response, shared by the fresh-broadcast path in settle() and the
        pending-settlement reconciliation path in _reconcile_pending_settlement().

        On confirm failure, records/refreshes the pending-settlement entry so a
        retry reconciles via the fast path instead of re-verifying/re-sending.
        """
        try:
            self._signer.confirm_transaction(signature, network)
        except Exception as e:
            try:
                self._pending_store.set(tx_key, signature)
            except Exception as store_error:
                # Can't guarantee a later retry will find this to reconcile
                # against — a blind retry could re-verify/re-broadcast and
                # double-send. Downgrade to terminal, preserving the signature
                # for manual reconciliation.
                return SettleResponse(
                    success=False,
                    error_reason=ERR_TRANSACTION_FAILED,
                    error_message=(
                        f"settlement_pending, but failed to persist for retry: {store_error}"
                    ),
                    transaction=signature,
                    network=network,
                    payer=payer,
                )
            return SettleResponse(
                success=False,
                error_reason=ERR_SETTLEMENT_PENDING,
                error_message=str(e),
                transaction=signature,
                network=network,
                payer=payer,
            )

        try:
            self._pending_store.delete(tx_key)
        except Exception:
            pass  # best-effort; a stale entry merely lingers until TTL expiry
        return SettleResponse(
            success=True,
            transaction=signature,
            network=network,
            payer=payer,
        )
