from pydantic import BaseModel, Field
from typing import Any, Optional
from uuid import uuid4


class Skill(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    content: str
    file_path: str = ""
    command: str = ""
    # Skills that OpenSwarm ships as part of the platform (e.g. the App
    # Builder reference) get this flag set. The UI hides the delete
    # button for them and the DELETE endpoint refuses with 409. Content
    # is still editable — the whole point is that users can tune how
    # the platform-internal agents behave.
    built_in: bool = False


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str
    command: str = ""


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None


class SkillWorkspaceSeedRequest(BaseModel):
    workspace_id: str
    skill_content: Optional[str] = None
    meta: Optional[dict[str, Any]] = None
