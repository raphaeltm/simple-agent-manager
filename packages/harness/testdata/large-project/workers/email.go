package workers

import "fmt"

// SendWelcomeEmail sends a welcome email to a new user.
func SendWelcomeEmail(email, name string) error {
	fmt.Printf("Sending welcome email to %s (%s)\n", name, email)
	return nil
}

// SendPasswordResetEmail sends a password reset email.
func SendPasswordResetEmail(email, resetToken string) error {
	fmt.Printf("Sending password reset to %s\n", email)
	return nil
}
