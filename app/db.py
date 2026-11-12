import os
from pathlib import Path
from uuid import uuid4

from sqlalchemy import JSON, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATA = Path(os.getenv("DATA_DIR", "data"))
DATA.mkdir(parents=True, exist_ok=True)
engine = create_engine(
    os.getenv("DATABASE_URL", f"sqlite:///{DATA / 'idp.sqlite3'}"),
    pool_pre_ping=True,
)
Session = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    sha256: Mapped[str] = mapped_column(String(64), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    media_type: Mapped[str]
    page_count: Mapped[int]
    status: Mapped[str] = mapped_column(default="queued")
    updated_at: Mapped[int]
    attempt: Mapped[str] = mapped_column(String(32), default=lambda: uuid4().hex)
    extraction: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    approved: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    notes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    method: Mapped[str | None]
    duration_ms: Mapped[int | None]
    model_tokens: Mapped[int | None]

    @property
    def path(self) -> Path:
        return DATA / self.id

    def summary(self) -> dict:
        return {
            "id": self.id,
            "filename": self.filename,
            "status": self.status,
            "method": self.method,
        }

    def detail(self) -> dict:
        return {
            **self.summary(),
            "attempt": self.attempt,
            "page_count": self.page_count,
            "extraction": self.extraction,
            "approved": self.approved,
            "notes": self.notes or [],
            "duration_ms": self.duration_ms,
            "model_tokens": self.model_tokens,
        }
