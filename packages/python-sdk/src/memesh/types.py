"""MeMesh type definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Entity:
    id: int
    name: str
    type: str
    created_at: str
    observations: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    relations: Optional[list[dict]] = None
    archived: Optional[bool] = None
    access_count: Optional[int] = None
    confidence: Optional[float] = None


@dataclass
class RememberResult:
    stored: bool
    entityId: int
    name: str
    type: str
    observations: int
    tags: int
    relations: int
    superseded: Optional[list[str]] = None


@dataclass
class ForgetResult:
    archived: Optional[bool] = None
    name: Optional[str] = None
    message: Optional[str] = None
    observation_removed: Optional[bool] = None
    remaining_observations: Optional[int] = None


@dataclass
class ConsolidateResult:
    consolidated: int
    entities_processed: list[str]
    observations_before: int
    observations_after: int
    error: Optional[str] = None
