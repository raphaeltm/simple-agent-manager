package db

// Project represents a project record.
type Project struct {
	ID     string
	Name   string
	UserID string
}

// CreateProject creates a new project.
func (d *DB) CreateProject(p *Project) error {
	return nil
}

// ListProjectsByUser returns all projects belonging to a user.
func (d *DB) ListProjectsByUser(userID string) ([]*Project, error) {
	return nil, nil
}
