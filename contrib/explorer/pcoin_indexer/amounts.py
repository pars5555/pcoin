"""Exact PCN <-> satoshi conversion.

CLAUDE.md section 11: "Amounts arrive as bare JSON numbers. There is no string
form -- JSON_BIGINT_AS_STRING only affects integers. Round to satoshis
explicitly."

The rule enforced here is stronger: a Python float is *rejected*, not rounded.
The RPC layer parses the response body with ``parse_float=Decimal`` so amounts
never become binary floats in the first place; this function exists to make a
regression in that plumbing a loud TypeError rather than a quiet 1-satoshi drift.
"""

from decimal import Decimal, ROUND_HALF_UP

COIN = 100_000_000
_ONE = Decimal(1)


def to_sat(value):
    """Convert an RPC amount to an exact integer number of satoshis."""
    if isinstance(value, bool):
        raise TypeError("bool is not an amount")
    if isinstance(value, int):
        d = Decimal(value)
    elif isinstance(value, Decimal):
        d = value
    elif isinstance(value, str):
        d = Decimal(value)
    else:
        raise TypeError(
            "refusing to convert %r (%s) to satoshis: parse JSON with "
            "parse_float=Decimal so amounts never become binary floats"
            % (value, type(value).__name__)
        )
    if not d.is_finite():
        raise ValueError("non-finite amount: %r" % (value,))
    scaled = d * COIN
    sat = int(scaled.quantize(_ONE, rounding=ROUND_HALF_UP))
    # Any non-zero remainder means the node handed us sub-satoshi precision,
    # which cannot happen -- if it does, something upstream is wrong.
    if scaled != Decimal(sat):
        raise ValueError("amount %r is not a whole number of satoshis" % (value,))
    return sat


def from_sat(sat):
    """Render satoshis as a fixed-point PCN string (never a float)."""
    sign = "-" if sat < 0 else ""
    sat = abs(int(sat))
    return "%s%d.%08d" % (sign, sat // COIN, sat % COIN)


def subsidy_sat(height, halving_interval=210_000, initial=50 * COIN):
    """Consensus block subsidy at `height`. Mirrors GetBlockSubsidy()."""
    halvings = height // halving_interval
    if halvings >= 64:
        return 0
    return initial >> halvings
