"""Application settings, loaded from the environment (and .env for local runs)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Core
    database_url: str = "sqlite:///./codepr_monitor.db"
    secret_key: str = "dev-only-insecure-key-change-me"
    session_cookie_name: str = "codepr_session"
    session_max_age_seconds: int = 60 * 60 * 12

    # Monitoring
    check_interval_seconds: int = 60
    request_timeout_seconds: float = 15.0
    history_retention_days: int = 30

    # The hbpr repo is private, so its deployed URL has to be supplied.
    hbpr_url: str = "https://github.com/adamb/hbpr"

    # Cloudflare Access service token, used for odoo.code.pr.
    cf_access_client_id: str = ""
    cf_access_client_secret: str = ""

    # Uptime Kuma
    uptime_kuma_embed_url: str = "http://localhost:3001"

    # Odoo push
    odoo_enabled: bool = False
    odoo_url: str = "https://odoo.code.pr"
    odoo_db: str = ""
    odoo_username: str = ""
    odoo_password: str = ""

    # Seeding
    seed_admin_password: str = ""
    seed_user_password: str = ""
    secrets_file: str = "SECRETS.md"

    @property
    def has_cf_access_token(self) -> bool:
        return bool(self.cf_access_client_id and self.cf_access_client_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
