"""One small interface over the LLM providers the team might use.

Configure with environment variables:
  GEO_LLM_PROVIDER = groq | anthropic | openai | stub   (default: groq)
  GEO_LLM_MODEL    = model id. Defaults: groq → openai/gpt-oss-20b,
                     anthropic → claude-haiku-4-5-20251001
  GEO_LLM_REASONING = low | medium | high               (gpt-oss only, default: low)
  GEO_LLM_MAX_OUTPUT = max tokens per reply (default 2500)
  Defaults keep each request under Groq's free-tier limit of 8K tokens per minute.
  GROQ_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY

Every agent asks for JSON and gets back a validated pydantic object. If the
model's JSON doesn't match the schema, the validation error is sent back once
so the model can fix it.
"""
from __future__ import annotations

import json
import os
import re
from typing import Callable, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

DEFAULT_MODELS = {"groq": "openai/gpt-oss-20b", "anthropic": "claude-haiku-4-5-20251001"}
GROQ_BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")


class LLMError(RuntimeError):
    pass


class LLM:
    def __init__(self, provider: str | None = None, model: str | None = None,
                 stub: Callable[[str, str, type[BaseModel]], dict] | None = None):
        self.provider = (provider or os.environ.get("GEO_LLM_PROVIDER") or "groq").lower()
        self.model = model or os.environ.get("GEO_LLM_MODEL") or DEFAULT_MODELS.get(self.provider)
        self._stub = stub
        if self.provider == "stub" and stub is None:
            raise LLMError("provider 'stub' needs a stub function (used in tests)")
        if self.provider not in ("groq", "anthropic", "openai", "stub"):
            raise LLMError(f"unknown GEO_LLM_PROVIDER {self.provider!r}")
        if self.provider == "openai" and not self.model:
            raise LLMError("set GEO_LLM_MODEL to the OpenAI model you want to use")

    @property
    def label(self) -> str:
        return f"{self.provider}:{self.model or 'stub'}"

    # -- raw text call -------------------------------------------------------
    def _complete(self, system: str, user: str, max_tokens: int) -> str:
        if self.provider == "anthropic":
            import anthropic
            client = anthropic.Anthropic()
            msg = client.messages.create(model=self.model, max_tokens=max_tokens, system=system,
                                         messages=[{"role": "user", "content": user}])
            return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        if self.provider == "openai":
            from openai import OpenAI
            client = OpenAI()
            resp = client.chat.completions.create(
                model=self.model, response_format={"type": "json_object"},
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
            return resp.choices[0].message.content or ""
        if self.provider == "groq":
            # Groq is OpenAI-compatible; gpt-oss is a reasoning model, so its thinking is kept
            # out of the answer and counts toward max_completion_tokens.
            from openai import BadRequestError, OpenAI
            key = os.environ.get("GROQ_API_KEY")
            if not key:
                raise LLMError("GROQ_API_KEY is not set — add it to .env (console.groq.com → API Keys)")
            client = OpenAI(api_key=key, base_url=GROQ_BASE_URL, max_retries=4)  # retries 429 rate limits
            extra = {}
            if "gpt-oss" in (self.model or ""):
                extra["reasoning_effort"] = os.environ.get("GEO_LLM_REASONING", "low")
            try:
                resp = client.chat.completions.create(
                    model=self.model, response_format={"type": "json_object"},
                    max_completion_tokens=min(max_tokens, int(os.environ.get("GEO_LLM_MAX_OUTPUT", "2500"))),
                    temperature=0.2,
                    messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                    **extra)
            except BadRequestError as e:
                # Groq rejects replies that aren't valid JSON (json_validate_failed);
                # return the failed text so json() can send it back for correction
                body = getattr(e, "body", None) or {}
                err = body.get("error", body) if isinstance(body, dict) else {}
                if isinstance(err, dict) and err.get("code") == "json_validate_failed":
                    return err.get("failed_generation") or ""
                raise
            return resp.choices[0].message.content or ""
        raise LLMError("unreachable")

    # -- structured call -----------------------------------------------------
    def json(self, system: str, user: str, schema: type[T], max_tokens: int = 8000) -> T:
        if self.provider == "stub":
            return schema.model_validate(self._stub(system, user, schema))
        schema_hint = json.dumps(schema.model_json_schema(), separators=(",", ":"))
        system_full = (f"{system}\n\nRespond with a single JSON object only — no prose, no code fences. "
                       f"It must validate against this JSON Schema:\n{schema_hint}")
        text = self._complete(system_full, user, max_tokens)
        for attempt in range(2):
            try:
                return schema.model_validate(extract_json(text))
            except (ValidationError, ValueError) as e:
                if attempt == 1:
                    raise LLMError(f"model output did not match the schema: {e}") from e
                text = self._complete(system_full,
                                      f"{user}\n\nYour previous answer was invalid:\n{e}\n"
                                      f"Previous answer:\n{text}\n\nReturn corrected JSON only.",
                                      max_tokens)
        raise LLMError("unreachable")


def extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object found in model output")
    return json.loads(text[start:end + 1])
