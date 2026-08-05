"""One error shape for the whole API.

Every failure comes back as ``{"error": {"code": ..., "message": ...}}`` with an
HTTP status, and the ``code`` is a stable machine-readable string. Two of them
carry meaning a client must not flatten:

``node_unreachable`` and ``broadcast_outcome_unknown`` are *not* "it failed".
They mean the question was not answered. CLAUDE.md section 7.2: a
``getrawtransaction`` failure read as "0 confirmations" is what turns an
unanswerable question into a definite "not confirmed", which in a send path
authorises spending the same coins twice.
"""


class ApiError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def payload(self):
        body = {"error": {"code": self.code, "message": self.message}}
        body["error"].update(self.extra)
        return body


def bad_request(message, **extra):
    return ApiError(400, "bad_request", message, **extra)


def not_found(message, **extra):
    return ApiError(404, "not_found", message, **extra)
