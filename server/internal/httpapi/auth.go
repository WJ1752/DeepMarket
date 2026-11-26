package httpapi

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"deepmarket/server/internal/auth"
	"deepmarket/server/internal/repo"
)

const sessionTTL = 24 * time.Hour

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a api) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/register", a.register)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("POST /api/auth/logout", a.authenticated(false, a.logout))
	mux.HandleFunc("GET /api/auth/me", a.authenticated(false, a.me))
}

func (a api) register(w http.ResponseWriter, r *http.Request) {
	var body credentials
	if !readJSON(w, r, &body) {
		return
	}
	if strings.ContainsRune(body.Username, 0) {
		writeAPIError(w, http.StatusBadRequest, "invalid username")
		return
	}
	account, err := a.players.CreatePlayerAccount(r.Context(), body.Username, body.Password, nil)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	a.issueSession(w, r, account, http.StatusCreated)
}

func (a api) login(w http.ResponseWriter, r *http.Request) {
	var body credentials
	if !readJSON(w, r, &body) {
		return
	}
	if body.Username == "" || body.Password == "" || strings.ContainsRune(body.Username, 0) {
		writeAPIError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	account, err := a.players.GetAccountByUsername(r.Context(), body.Username)
	if errors.Is(err, repo.ErrNotFound) || (err == nil && account.User.Disabled) {
		writeAPIError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	valid, err := auth.VerifyPassword(body.Password, account.User.PasswordHash)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	if !valid {
		writeAPIError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	a.issueSession(w, r, account, http.StatusOK)
}

func (a api) issueSession(w http.ResponseWriter, r *http.Request, account *repo.AccountSnapshot, status int) {
	ctx, userID := r.Context(), account.User.ID
	if _, err := a.repo.EnsureStarterRod(ctx, userID); err != nil {
		writeFishingError(w, r, err)
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	session, err := a.repo.CreateSession(ctx, userID, sessionTTL, ip, r.UserAgent())
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, status, map[string]any{
		"ok": true, "token": session.ID,
		"user": publicUser(account.User), "player": publicPlayer(account.Player),
	})
}

func (a api) logout(w http.ResponseWriter, r *http.Request, userID int64) {
	if err := a.repo.DeleteSession(r.Context(), sessionToken(r, false), userID); err != nil {
		writeFishingError(w, r, err)
		return
	}
	if _, err := r.Cookie("deepmarket_session"); err == nil {
		http.SetCookie(w, &http.Cookie{
			Name: "deepmarket_session", Path: "/", MaxAge: -1, HttpOnly: true,
			Secure: r.TLS != nil, SameSite: http.SameSiteLaxMode,
		})
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a api) me(w http.ResponseWriter, r *http.Request, userID int64) {
	account, err := a.players.GetAccountByUserID(r.Context(), userID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "user": publicUser(account.User), "player": publicPlayer(account.Player),
	})
}

func publicUser(user repo.User) map[string]any {
	return map[string]any{
		"id": user.ID, "username": user.Username, "email": user.Email, "role": user.Role,
		"created_at": user.CreatedAt, "updated_at": user.UpdatedAt,
	}
}

func publicPlayer(player repo.Player) map[string]any {
	return map[string]any{
		"user_id": player.UserID, "version": player.Version, "inv_rev": player.InvRev,
		"coins": player.Coins, "black_coins": player.BlackCoins, "state": player.State,
		"last_fishing_settle_at": player.LastFishingSettleAt, "house_last_claim_at": player.HouseLastClaimAt,
		"created_at": player.CreatedAt, "updated_at": player.UpdatedAt,
	}
}
