package handlers

import "example/db"

// HandleCreateProject creates a new project for a user.
func (r *Router) HandleCreateProject(name, userID string) error {
	project := &db.Project{Name: name, UserID: userID}
	return r.db.CreateProject(project)
}

// HandleListProjects returns all projects for a user.
func (r *Router) HandleListProjects(userID string) ([]*db.Project, error) {
	return r.db.ListProjectsByUser(userID)
}
