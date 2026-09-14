package paymentchannels

import (
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// The open verifier reads a ComputeBudget prefix and static account keys that
// only legacy and v0 messages carry in the shape it models, so any other
// version must be refused before a single instruction is inspected.
func TestVerifyOpenTransactionRejectsUnsupportedTransactionVersions(t *testing.T) {
	fixture := newOpenFixture(t)
	raw, err := base64.StdEncoding.DecodeString(fixture.buildSignedOpen(t, nil, nil))
	require.NoError(t, err)

	tx, err := svm.DecodeTransaction(base64.StdEncoding.EncodeToString(raw))
	require.NoError(t, err)
	offset := 1 + 64*len(tx.Signatures)
	require.Equal(t, byte(0x80), raw[offset], "fixture must be a v0 transaction")
	raw[offset] = 0x81

	_, err = VerifyOpenTransaction(base64.StdEncoding.EncodeToString(raw), fixture.expected())
	require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
	require.ErrorContains(t, err, "unsupported transaction message version 2")
}
