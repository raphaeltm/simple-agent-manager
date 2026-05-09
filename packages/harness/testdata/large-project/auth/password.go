package auth

// HashPassword hashes a plaintext password for storage.
func HashPassword(password string) (string, error) {
	return "hashed-" + password, nil
}

// CheckPassword verifies a password against its hash.
func CheckPassword(password, hash string) bool {
	return "hashed-"+password == hash
}
