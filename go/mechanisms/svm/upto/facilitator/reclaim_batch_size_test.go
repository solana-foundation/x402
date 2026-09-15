package facilitator

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// buildReclaimBatch returns the exact distinct-channel instruction set the
// cleanup packer evaluates before broadcasting.
func buildReclaimBatch(t *testing.T, n int) (solana.PublicKey, []solana.Instruction) {
	t.Helper()
	rentPayer, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	instructions := make([]solana.Instruction, 0, n)
	for i := 0; i < n; i++ {
		channel, err := solana.NewRandomPrivateKey()
		require.NoError(t, err)
		instructions = append(instructions,
			paymentchannels.BuildReclaimInstruction(channel.PublicKey(), rentPayer.PublicKey()))
	}
	return rentPayer.PublicKey(), instructions
}

func TestReclaimBatchUsesEveryAvailableV1Account(t *testing.T) {
	t.Parallel()

	// fee payer + program id + one distinct channel per instruction = 64 keys.
	feePayer, instructions := buildReclaimBatch(t, 62)
	limit := ReclaimComputeUnitLimit(len(instructions))
	loadedLimit := ReclaimLoadedAccountsDataSizeLimit(len(instructions))
	opts := submitSettleOptions{
		ComputeUnitLimit:            &limit,
		LoadedAccountsDataSizeLimit: &loadedLimit,
	}
	require.True(t, facilitatorV1TransactionFits(feePayer, instructions, opts))

	tx, err := buildSettleTransaction(feePayer, solana.Hash{}, instructions, opts)
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)
	require.Len(t, tx.Message.AccountKeys, solana.MaxAddressesV1)
	require.LessOrEqual(t, len(wire), solana.MaxTransactionSizeV1)
}

func TestReclaimBatchRejectsTheFirstAccountOverTheV1Limit(t *testing.T) {
	t.Parallel()

	feePayer, instructions := buildReclaimBatch(t, 63)
	limit := ReclaimComputeUnitLimit(len(instructions))
	loadedLimit := ReclaimLoadedAccountsDataSizeLimit(len(instructions))
	require.False(t, facilitatorV1TransactionFits(feePayer, instructions, submitSettleOptions{
		ComputeUnitLimit:            &limit,
		LoadedAccountsDataSizeLimit: &loadedLimit,
	}))
}

func TestFacilitatorV1PackingChecksInstructionAndWireLimits(t *testing.T) {
	t.Parallel()
	payer := solana.NewWallet().PublicKey()
	tiny := solana.NewInstruction(solana.MemoProgramID, nil, []byte("x"))
	instructions := make([]solana.Instruction, solana.MaxInstructionsV1)
	for i := range instructions {
		instructions[i] = tiny
	}
	require.True(t, facilitatorV1TransactionFits(payer, instructions, submitSettleOptions{}))
	require.False(t, facilitatorV1TransactionFits(payer, append(instructions, tiny), submitSettleOptions{}))

	tooLarge := solana.NewInstruction(solana.MemoProgramID, nil, make([]byte, 4_000))
	require.False(t, facilitatorV1TransactionFits(payer, []solana.Instruction{tooLarge}, submitSettleOptions{}))
}

func TestCleanupOptionsClampsMaxReclaimsPerTxToV1InstructionLimit(t *testing.T) {
	t.Parallel()
	opts := CleanupOptions{MaxReclaimsPerTx: MaxSafeReclaimsPerTx + 100}.withDefaults()
	require.Equal(t, solana.MaxInstructionsV1, opts.MaxReclaimsPerTx)
}
