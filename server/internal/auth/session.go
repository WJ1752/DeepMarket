package auth

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// Session holds the persisted metadata for an authenticated session.
type Session struct {
	ID        string
	UserID    int64
	ExpiresAt time.Time
	IP        string
	UserAgent string
	CreatedAt time.Time
}

// GenerateSessionID returns a 256-bit cryptographically random session token.
func GenerateSessionID() (string, error) {
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}
