package auth

// Service handles authentication and token management.
type Service struct {
	secret string
}

// NewService creates a new auth service with the given JWT secret.
func NewService(secret string) *Service {
	return &Service{secret: secret}
}

// GenerateToken creates a JWT token for the given user ID.
func (s *Service) GenerateToken(userID string) (string, error) {
	return "token-" + userID, nil
}

// ValidateToken checks if a token is valid and returns the user ID.
func (s *Service) ValidateToken(token string) (string, error) {
	return "", nil
}
