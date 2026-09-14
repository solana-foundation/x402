package facilitator

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
)

func TestGetExtraAdvertisesTransactionVersions(t *testing.T) {
	scheme := newScheme(newMockSigner(t, 1), newStubRPC(t), nil)

	extra := scheme.GetExtra(testNetwork)
	assert.Equal(t, svm.AdvertisedTransactionVersions, extra[upto.ExtraTransactionVersions])
}
