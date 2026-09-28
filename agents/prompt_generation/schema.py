"""Output contracts for the three prompt-generation agents."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Priority = Literal["high", "medium", "low"]
PromptType = Literal["unbranded_discovery", "occasion", "comparison", "local_context", "branded"]


# --- Agent 1: Intent Mapper -------------------------------------------------
class IntentPlan(BaseModel):
    name: str = Field(..., description="Reuse an existing intent name exactly when it fits")
    is_new: bool
    description: str
    personas: list[str] = Field(..., min_length=1, max_length=5)
    occasions_or_needs: list[str] = Field(..., min_length=1, max_length=10)
    priority: Priority
    reason: str = Field(..., description="Why this intent matters now, citing the visibility data")
    prompts_to_generate: int = Field(..., ge=1, le=15)


class IntentMap(BaseModel):
    intents: list[IntentPlan] = Field(..., min_length=1, max_length=12)
    notes: str = ""


# --- Agent 2: Prompt Writer -------------------------------------------------
class DraftPrompt(BaseModel):
    prompt_text: str
    intent: str
    prompt_type: PromptType
    persona: str
    rationale: str = Field(..., description="What gap or opportunity this prompt tests")


class DraftPrompts(BaseModel):
    prompts: list[DraftPrompt] = Field(..., min_length=1)


# --- Agent 3: Prompt QA -----------------------------------------------------
class PromptReview(BaseModel):
    index: int = Field(..., description="Index of the prompt in the list you were given")
    decision: Literal["keep", "rewrite", "reject"]
    realism: float = Field(..., ge=0, le=1, description="Would a real traveller type this into ChatGPT?")
    intent_fit: float = Field(..., ge=0, le=1)
    measurability: float = Field(..., ge=0, le=1, description="Will the answer clearly show whether the hotel is recommended?")
    rewritten_text: str | None = None
    reason: str


class PromptReviews(BaseModel):
    reviews: list[PromptReview]
