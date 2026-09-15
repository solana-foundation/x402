package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// The open verifier reads a ComputeBudget prefix and static account keys that
// only legacy and v0 messages carry in the shape it models, so any other
// version must be refused before a single instruction is inspected.
func TestVerifyOpenTransactionRejectsUnsupportedTransactionVersions(t *testing.T) {
	fixture := newOpenFixture(t)
	payer := solana.NewWallet()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(solana.MemoProgramID, nil, []byte("v1"))},
		solana.Hash{},
		solana.TransactionPayer(payer.PublicKey()),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(10_000).
			WithLoadedAccountsDataSizeLimit(65_536)),
	)
	require.NoError(t, err)
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payer.PublicKey()) {
			return &payer.PrivateKey
		}
		return nil
	})
	require.NoError(t, err)
	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	_, err = VerifyOpenTransaction(encoded, fixture.expected())
	require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
	require.ErrorContains(t, err, "unsupported transaction message version 1")
}
