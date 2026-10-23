/**
 * Named error reason constants for the atomic-batch SVM facilitator.
 *
 * These strings are the wire-level `invalidReason` / `errorReason` values
 * defined by specs/schemes/atomic-batch/scheme_atomic_batch_svm.md. Keep
 * them character-for-character identical to that document.
 */

// Requirements errors
export const ErrUnsupportedScheme = "invalid_atomic_batch_svm_unsupported_scheme";
export const ErrUnsupportedNetwork = "invalid_atomic_batch_svm_unsupported_network";
export const ErrMissingItems = "invalid_atomic_batch_svm_requirements_missing_items";
export const ErrInvalidItems = "invalid_atomic_batch_svm_requirements_invalid_items";
export const ErrAmountSumMismatch = "invalid_atomic_batch_svm_requirements_amount_mismatch";

// Verify errors
export const ErrInvalidPayloadTransaction = "invalid_atomic_batch_svm_payload_transaction";
export const ErrTransactionCouldNotBeDecoded =
  "invalid_atomic_batch_svm_payload_transaction_could_not_be_decoded";
export const ErrMissingSignatures = "invalid_atomic_batch_svm_payload_missing_signatures";
export const ErrSignatureInvalid = "invalid_atomic_batch_svm_payload_signature_invalid";
export const ErrExcessiveSigners = "invalid_atomic_batch_svm_payload_excessive_signers";
export const ErrAuthorityNotPayer = "invalid_atomic_batch_svm_payload_authority_not_payer";
export const ErrInvalidBatch = "invalid_atomic_batch_svm_payload_invalid_batch";
export const ErrItemCountMismatch = "invalid_atomic_batch_svm_payload_item_count_mismatch";
export const ErrWrongAsset = "invalid_atomic_batch_svm_payload_wrong_asset";
export const ErrWrongDecimals = "invalid_atomic_batch_svm_payload_wrong_decimals";
export const ErrInsufficientAmount = "invalid_atomic_batch_svm_payload_insufficient_amount";
export const ErrDestinationMismatch = "invalid_atomic_batch_svm_payload_destination_mismatch";
export const ErrWrongRecipient = "invalid_atomic_batch_svm_payload_wrong_recipient";
export const ErrSourceMismatch = "invalid_atomic_batch_svm_payload_source_mismatch";
export const ErrDuplicateItem = "invalid_atomic_batch_svm_payload_duplicate_item";
export const ErrSimulationFailed = "invalid_atomic_batch_svm_transaction_simulation_failed";

// Settle errors
export const ErrVerificationFailed = "invalid_atomic_batch_svm_verification_failed";
export const ErrTransactionFailed = "invalid_atomic_batch_svm_transaction_failed";
export const ErrDuplicateSettlement = "duplicate_settlement";
