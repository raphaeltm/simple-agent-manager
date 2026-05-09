class TokenBudget:
    def __init__(self, max_tokens: int):
        self.max_tokens = max_tokens
        self.used = 0

    def remaining(self) -> int:
        return self.max_tokens - self.used

def count_tokens(text: str) -> int:
    return len(text.split())

async def fetch_data(url: str) -> dict:
    pass

class Config:
    pass
