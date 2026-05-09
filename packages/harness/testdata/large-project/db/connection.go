package db

// DB represents a database connection.
type DB struct {
	URL string
}

// Connect creates a new database connection.
func Connect(url string) *DB {
	return &DB{URL: url}
}

// Close closes the database connection.
func (d *DB) Close() error {
	return nil
}
