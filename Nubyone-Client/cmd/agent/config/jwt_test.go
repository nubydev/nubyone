package config

import "testing"

func TestVerifyBuildJWT_Empty(t *testing.T) {
	origJWT, origPub := BuildJWT, ServerPublicKey
	defer func() { BuildJWT, ServerPublicKey = origJWT, origPub }()

	BuildJWT, ServerPublicKey = "", ""
	if err := VerifyBuildJWT(); err != nil {
		t.Fatalf("empty JWT should pass: %v", err)
	}
}

func TestVerifyBuildJWT_Valid(t *testing.T) {
	origJWT, origPub := BuildJWT, ServerPublicKey
	defer func() { BuildJWT, ServerPublicKey = origJWT, origPub }()

	// Real JWT + pubkey produced by jwt.ts in a smoke run:
	BuildJWT = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9" +
		".eyJpc3MiOiJ6Yy1zZXJ2ZXIiLCJhdWQiOiJ6Yy1hZ2VudCIsInN1YiI6ImdvLXRlc3QtMDAxIiwiaWF0IjoxNzc3NjM5NzMzLCJleHAiOjE4MDkxNzU3MzMsInNydiI6Imh0dHBzOi8vdGVzdC5leGFtcGxlLmNvbSIsInRhZyI6IiJ9" +
		".sOtFRK-lormrYWJyQf2RA2OYw17XOajm5fZdY9Tyr4PhcIWnre6DWE4G7OMVP8CczDb0HwTN8Tb_-E5_N4VCDg"
	ServerPublicKey = "lCU00RIDns0vg87yi+nNbNuigblLa5Ux+7Kz9GsVba0="

	if err := VerifyBuildJWT(); err != nil {
		t.Fatalf("valid JWT should verify: %v", err)
	}
}

func TestVerifyBuildJWT_Tampered(t *testing.T) {
	origJWT, origPub := BuildJWT, ServerPublicKey
	defer func() { BuildJWT, ServerPublicKey = origJWT, origPub }()

	// Flip one byte in the signature segment — must fail.
	BuildJWT = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9" +
		".eyJpc3MiOiJ6Yy1zZXJ2ZXIiLCJhdWQiOiJ6Yy1hZ2VudCIsInN1YiI6ImdvLXRlc3QtMDAxIiwiaWF0IjoxNzc3NjM5NzMzLCJleHAiOjE4MDkxNzU3MzMsInNydiI6Imh0dHBzOi8vdGVzdC5leGFtcGxlLmNvbSIsInRhZyI6IiJ9" +
		".XXXXXXRK-lormrYWJyQf2RA2OYw17XOajm5fZdY9Tyr4PhcIWnre6DWE4G7OMVP8CczDb0HwTN8Tb_-E5_N4VCDg"
	ServerPublicKey = "lCU00RIDns0vg87yi+nNbNuigblLa5Ux+7Kz9GsVba0="

	if err := VerifyBuildJWT(); err == nil {
		t.Fatal("tampered JWT should fail verification")
	}
}

func TestVerifyBuildJWT_WrongKey(t *testing.T) {
	origJWT, origPub := BuildJWT, ServerPublicKey
	defer func() { BuildJWT, ServerPublicKey = origJWT, origPub }()

	BuildJWT = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9" +
		".eyJpc3MiOiJ6Yy1zZXJ2ZXIiLCJhdWQiOiJ6Yy1hZ2VudCIsInN1YiI6ImdvLXRlc3QtMDAxIiwiaWF0IjoxNzc3NjM5NzMzLCJleHAiOjE4MDkxNzU3MzMsInNydiI6Imh0dHBzOi8vdGVzdC5leGFtcGxlLmNvbSIsInRhZyI6IiJ9" +
		".sOtFRK-lormrYWJyQf2RA2OYw17XOajm5fZdY9Tyr4PhcIWnre6DWE4G7OMVP8CczDb0HwTN8Tb_-E5_N4VCDg"
	// Different (random) 32-byte public key — must fail.
	ServerPublicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

	if err := VerifyBuildJWT(); err == nil {
		t.Fatal("wrong public key should fail verification")
	}
}
