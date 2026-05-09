package handlers

import "example/db"

// HandleCreateUser handles user registration.
func (r *Router) HandleCreateUser(email, password, name string) error {
	user := &db.User{Email: email, Name: name}
	return r.db.CreateUser(user)
}

// HandleGetUser retrieves a user by ID.
func (r *Router) HandleGetUser(id string) (*db.User, error) {
	return r.db.GetUserByID(id)
}
