"""Errors that stop a job step. NeedsReview pauses the job for an operator; anything else fails it."""


class NeedsReview(Exception):
    """The input is not trustworthy enough to continue automatically.

    `code` is a stable machine-readable reason, `details` is shown on the review form.
    """

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details}
