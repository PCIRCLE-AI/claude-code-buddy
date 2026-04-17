"""MeMesh — The lightest universal AI memory layer."""

from .client import MeMesh
from .types import ConsolidateResult, Entity, ForgetResult, RememberResult

__version__ = "3.0.0b1"
__all__ = ["MeMesh", "Entity", "RememberResult", "ForgetResult", "ConsolidateResult"]
