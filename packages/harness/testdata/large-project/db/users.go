package db

// User represents a user record.
type User struct {
	ID       string
	Email    string
	Name     string
	PassHash string
}

// CreateUser inserts a new user into the database.
func (d *DB) CreateUser(u *User) error {
	return nil
}

// GetUserByEmail retrieves a user by email address.
func (d *DB) GetUserByEmail(email string) (*User, error) {
	return nil, nil
}

// GetUserByID retrieves a user by ID.
func (d *DB) GetUserByID(id string) (*User, error) {
	return nil, nil
}
