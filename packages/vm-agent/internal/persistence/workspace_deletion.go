package persistence

import (
	"database/sql"
	"time"
)

func migrateV20(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS workspace_deletions (workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS workspace_owned_roots (workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`)
	return err
}

// Intents survive process restart and remain as idempotency tombstones after success.
func (s *Store) PutWorkspaceDeletion(id, payload string) error {
	_, err := s.db.Exec(`INSERT INTO workspace_deletions(workspace_id,payload) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload, updated_at=unixepoch()`, id, payload)
	return err
}
func (s *Store) WorkspaceDeletions(limit int) (map[string]string, error) {
	rows, err := s.db.Query(`SELECT workspace_id,payload FROM workspace_deletions WHERE COALESCE(json_extract(payload,'$.finalized'),0)=0 ORDER BY updated_at, workspace_id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var id, p string
		if err := rows.Scan(&id, &p); err != nil {
			return nil, err
		}
		result[id] = p
	}
	return result, rows.Err()
}
func (s *Store) GetWorkspaceDeletion(id string) (string, error) {
	var p string
	err := s.db.QueryRow(`SELECT payload FROM workspace_deletions WHERE workspace_id=?`, id).Scan(&p)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return p, err
}

func (s *Store) PutOwnedWorkspaceRoot(id, payload string) error {
	_, err := s.db.Exec(`INSERT INTO workspace_owned_roots(workspace_id,payload) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload`, id, payload)
	return err
}
func (s *Store) GetOwnedWorkspaceRoot(id string) (string, error) {
	var p string
	err := s.db.QueryRow(`SELECT payload FROM workspace_owned_roots WHERE workspace_id=?`, id).Scan(&p)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return p, err
}

func (s *Store) DeleteOwnedWorkspaceRoot(id string) error {
	_, err := s.db.Exec(`DELETE FROM workspace_owned_roots WHERE workspace_id=?`, id)
	return err
}
func (s *Store) PruneFinalizedWorkspaceDeletions(before time.Time, limit int) (int64, error) {
	result, err := s.db.Exec(`DELETE FROM workspace_deletions WHERE workspace_id IN (SELECT workspace_id FROM workspace_deletions WHERE json_extract(payload,'$.finalized')=1 AND updated_at<? ORDER BY updated_at,workspace_id LIMIT ?)`, before.Unix(), limit)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
