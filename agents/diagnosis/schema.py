"""Output contract of the diagnosis agent (validated before anything is saved)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

DiagnosisType = Literal["content_gap", "citation_gap", "entity_confusion",
                        "negative_sentiment", "competitor_dominance", "other"]
ActionType = Literal["content", "technical", "pr_outreach", "listing", "other"]
Level = Literal["low", "medium", "high"]


class Recommendation(BaseModel):
    title: str = Field(..., max_length=120, description="Imperative, specific action, e.g. 'Publish a baby shower page'")
    detail: str = Field(..., description="What to do and why, 1-3 sentences, grounded in the evidence")
    action_type: ActionType
    priority: Level
    expected_impact: str = Field(..., description="Which metric should move and why")
    evidence_ids: list[str] = Field(default_factory=list, description="IDs from the EVIDENCE list that justify it")


class DiagnosisOutput(BaseModel):
    diagnosis_needed: bool = Field(..., description="false when the hotel is already ranked well and nothing is wrong")
    summary: str = Field(..., description="One sentence a hotel marketer understands")
    diagnosis_type: DiagnosisType
    root_cause: str = Field(..., description="Why the hotel did or didn't appear, citing evidence IDs in [brackets]")
    severity: Level
    confidence: float = Field(..., ge=0, le=1)
    supporting_evidence_ids: list[str] = Field(default_factory=list)
    contradicting_evidence_ids: list[str] = Field(default_factory=list)
    recommendations: list[Recommendation] = Field(default_factory=list, max_length=4)
    open_questions: list[str] = Field(default_factory=list,
                                      description="Facts a human must check before acting (e.g. does the page exist?)")

    @field_validator("recommendations")
    @classmethod
    def recs_when_needed(cls, v, info):
        if info.data.get("diagnosis_needed") and not v:
            raise ValueError("give at least one recommendation when diagnosis_needed is true")
        return v
