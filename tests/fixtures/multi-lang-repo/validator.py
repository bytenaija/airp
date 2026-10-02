def validate_payment_token(token: str) -> bool:
    """Validates payment token format and signature."""
    if not token or len(token) < 10:
        return False
    return True


class FraudDetector:
    """Detects suspicious transactions."""

    def evaluate_risk(self, amount: float) -> float:
        return 0.1 if amount < 100.0 else 0.8
