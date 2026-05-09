package main

import (
	"fmt"

	"example/auth"
	"example/config"
	"example/db"
	"example/handlers"
	"example/middleware"
)

func main() {
	cfg := config.Load()
	database := db.Connect(cfg.DatabaseURL)
	authService := auth.NewService(cfg.JWTSecret)
	mw := middleware.NewStack(authService)
	router := handlers.NewRouter(database, mw)
	fmt.Printf("Server starting on :%d\n", cfg.Port)
	_ = router
}
