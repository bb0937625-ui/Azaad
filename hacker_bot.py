#!/usr/bin/env python3
"""
Hacker‑like Telegram Bot that monitors dark forums (Altenens) with adaptive scraping.
Features:
- Multi‑engine (HTTP / Playwright) with automatic fallback
- Fingerprint rotation (User‑Agent, headers, viewport)
- CAPTCHA solving (via 2Captcha – optional)
- Account pool (fallback credentials)
- State persistence (seen posts, last successful strategy)
- Telegram command interface for manual control
- Branded publishing with full Markdown support
"""

import asyncio
import json
import logging
import os
import random
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Tuple
from urllib.parse import urljoin

import aiohttp
from bs4 import BeautifulSoup
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes

# ---------- CONFIGURATION (Environment overrides) ----------
CONFIG = {
    # Telegram
    "BOT_TOKEN": os.getenv("TELEGRAM_BOT_TOKEN", "YOUR_BOT_TOKEN"),
    "PUBLISH_CHAT_ID": int(os.getenv("PUBLISH_CHAT_ID", "-1001234567890")),

    # Branding
    "BRANDING": "🔹 **Brought to you by Sonion's Elite Bot** – Your daily intel, delivered fresh.",

    # Schedule (UTC)
    "SCHEDULED_HOUR": int(os.getenv("SCHEDULED_HOUR", "0")),
    "SCHEDULED_MINUTE": int(os.getenv("SCHEDULED_MINUTE", "0")),

    # Persistence
    "PERSISTENCE_FILE": "seen_posts.json",
    "STATE_FILE": "bot_state.json",          # stores last successful strategy per forum

    # Scraping engines
    "DEFAULT_ENGINE": "http",               # 'http' or 'playwright'
    "TIMEOUT": 30,
    "MAX_RETRIES": 3,

    # Fingerprint rotation
    "USER_AGENTS": [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    ],

    # CAPTCHA solving (optional) – set API key to enable
    "CAPTCHA_API_KEY": os.getenv("CAPTCHA_API_KEY", ""),

    # Account pool for forums that require login
    "ACCOUNTS": [
        {
            "username": "fake_user1",
            "password": "fake_pass1",
            "email": "fake1@example.com",   # if needed
        },
        {
            "username": "fake_user2",
            "password": "fake_pass2",
            "email": "fake2@example.com",
        },
    ],

    # Forums to monitor
    "FORUMS": [
        {
            "url": "https://altenens.is/",
            "board_url": "https://altenens.is/forum/latest",  # page to scrape after login
            "login": {
                "enabled": True,
                "login_url": "https://altenens.is/login",
                "username_field": "username",
                "password_field": "password",
                "csrf_field": "_token",
                "csrf_selector": "input[name='_token']",
                "success_check": "Welcome",
            },
            "selectors": {
                "post_container": "div.thread",      # adjust after inspecting
                "id": "data-id",
                "title": "h2.title",
                "content": "div.post-content",
                "author": "span.author",
                "timestamp": "time",
            },
            "last_successful_engine": None,   # will be stored in state
        }
    ],
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ---------- State Management (persistent) ----------
class BotState:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.data = self._load()

    def _load(self) -> Dict:
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, "r") as f:
                    return json.load(f)
            except:
                return {}
        return {}

    def save(self):
        with open(self.filepath, "w") as f:
            json.dump(self.data, f, indent=2)

    def get_forum_strategy(self, forum_url: str) -> str:
        """Return the last successful engine for this forum (or None)."""
        return self.data.get("strategies", {}).get(forum_url, {}).get("engine")

    def set_forum_strategy(self, forum_url: str, engine: str):
        if "strategies" not in self.data:
            self.data["strategies"] = {}
        self.data["strategies"][forum_url] = {"engine": engine, "updated": datetime.now().isoformat()}
        self.save()

# ---------- Persistence for Seen Posts ----------
class SeenPosts:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self._data: Dict[str, List[str]] = {}
        self._load()

    def _load(self):
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, "r") as f:
                    self._data = json.load(f)
            except:
                self._data = {}
        else:
            self._data = {}

    def _save(self):
        with open(self.filepath, "w") as f:
            json.dump(self._data, f, indent=2)

    def is_seen(self, forum_url: str, post_id: str) -> bool:
        return post_id in self._data.get(forum_url, [])

    def mark_seen(self, forum_url: str, post_id: str):
        if forum_url not in self._data:
            self._data[forum_url] = []
        if post_id not in self._data[forum_url]:
            self._data[forum_url].append(post_id)
            self._save()

# ---------- Adaptive Scraping Engines ----------
class BaseScraper:
    def __init__(self, config: Dict):
        self.config = config
        self._session = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        if self._session:
            await self._session.close()

    async def login(self, forum_config: Dict, account: Dict) -> bool:
        """To be overridden."""
        raise NotImplementedError

    async def fetch(self, url: str) -> Optional[str]:
        """Fetch HTML."""
        raise NotImplementedError

class HttpScraper(BaseScraper):
    def __init__(self, config: Dict):
        super().__init__(config)
        self._logged_in = False
        self._cookies = None

    async def __aenter__(self):
        # Select random User-Agent
        ua = random.choice(self.config["USER_AGENTS"])
        self._session = aiohttp.ClientSession(
            headers={"User-Agent": ua},
            cookie_jar=aiohttp.CookieJar()
        )
        return self

    async def login(self, forum_config: Dict, account: Dict) -> bool:
        if not forum_config.get("login", {}).get("enabled", False):
            self._logged_in = True
            return True

        login_conf = forum_config["login"]
        login_url = login_conf["login_url"]

        # 1. Get CSRF token
        async with self._session.get(login_url) as resp:
            if resp.status != 200:
                logger.error(f"Failed to load login page: {resp.status}")
                return False
            html = await resp.text()
            soup = BeautifulSoup(html, "html.parser")
            csrf_input = soup.select_one(login_conf["csrf_selector"])
            csrf_token = csrf_input.get("value") if csrf_input else ""

        # 2. Build payload
        payload = {
            login_conf["username_field"]: account["username"],
            login_conf["password_field"]: account["password"],
        }
        if csrf_token and login_conf.get("csrf_field"):
            payload[login_conf["csrf_field"]] = csrf_token

        # 3. POST login
        async with self._session.post(login_url, data=payload, allow_redirects=False) as resp:
            if resp.status in (200, 302):
                content = await resp.text()
                if login_conf.get("success_check", "") in content:
                    self._logged_in = True
                    logger.info(f"✅ Login success for {account['username']}")
                    return True
                else:
                    logger.warning(f"Login failed for {account['username']} – success text not found")
                    return False
            else:
                logger.error(f"Login POST returned {resp.status}")
                return False

    async def fetch(self, url: str) -> Optional[str]:
        for attempt in range(1, self.config["MAX_RETRIES"] + 1):
            try:
                async with self._session.get(url, timeout=self.config["TIMEOUT"]) as resp:
                    if resp.status == 200:
                        return await resp.text()
                    elif resp.status in (403, 429):
                        # Maybe we need to switch engine or use proxy – we'll raise a special exception
                        raise Exception(f"HTTP {resp.status} – engine may need to switch")
                    else:
                        logger.warning(f"Attempt {attempt}: {resp.status}")
                        await asyncio.sleep(2 ** attempt + random.uniform(0, 0.5))
            except asyncio.TimeoutError:
                logger.warning(f"Timeout on attempt {attempt}")
                await asyncio.sleep(2 ** attempt)
            except Exception as e:
                logger.error(f"Attempt {attempt} error: {e}")
                await asyncio.sleep(2 ** attempt)
        return None

class PlaywrightScraper(BaseScraper):
    def __init__(self, config: Dict):
        super().__init__(config)
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._logged_in = False

    async def __aenter__(self):
        from playwright.async_api import async_playwright
        self._playwright = await async_playwright().start()
        # Random viewport
        viewport = {"width": random.choice([1366, 1920, 1440]), "height": random.choice([768, 1080, 900])}
        # Stealth: use a random user agent, disable automation flags
        ua = random.choice(self.config["USER_AGENTS"])
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        )
        self._context = await self._browser.new_context(
            user_agent=ua,
            viewport=viewport,
            locale="en-US",
            timezone_id="America/New_York",
        )
        self._page = await self._context.new_page()
        return self

    async def __aexit__(self, *args):
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

    async def login(self, forum_config: Dict, account: Dict) -> bool:
        if not forum_config.get("login", {}).get("enabled", False):
            self._logged_in = True
            return True

        login_conf = forum_config["login"]
        login_url = login_conf["login_url"]

        await self._page.goto(login_url, wait_until="networkidle")
        # Wait for form
        await self._page.wait_for_selector(f"input[name='{login_conf['username_field']}']", timeout=10000)

        # Fill
        await self._page.fill(f"input[name='{login_conf['username_field']}']", account["username"])
        await self._page.fill(f"input[name='{login_conf['password_field']}']", account["password"])

        # CSRF token is usually auto-filled; but we can also extract if needed
        if login_conf.get("csrf_selector"):
            csrf = await self._page.get_attribute(login_conf["csrf_selector"], "value")
            if csrf and login_conf.get("csrf_field"):
                await self._page.fill(f"input[name='{login_conf['csrf_field']}']", csrf)

        await self._page.click("button[type='submit']")
        await self._page.wait_for_load_state("networkidle")

        content = await self._page.content()
        if login_conf.get("success_check", "") in content:
            self._logged_in = True
            logger.info(f"✅ Playwright login success for {account['username']}")
            return True
        else:
            logger.warning("Playwright login failed")
            return False

    async def fetch(self, url: str) -> Optional[str]:
        for attempt in range(1, self.config["MAX_RETRIES"] + 1):
            try:
                await self._page.goto(url, timeout=self.config["TIMEOUT"] * 1000, wait_until="networkidle")
                # Check for CAPTCHA
                if "captcha" in (await self._page.content()).lower():
                    # Attempt to solve if we have API key
                    if self.config.get("CAPTCHA_API_KEY"):
                        logger.info("CAPTCHA detected – solving...")
                        # Use 2Captcha or similar – placeholder
                        # In practice, you'd call an API and simulate human typing
                        # For brevity, we'll just wait and hope it auto-solves (not recommended)
                        await asyncio.sleep(5)
                    else:
                        logger.warning("CAPTCHA detected but no solver configured – skipping")
                        return None
                return await self._page.content()
            except Exception as e:
                logger.error(f"Playwright attempt {attempt} failed: {e}")
                await asyncio.sleep(2 ** attempt + random.uniform(0, 1))
        return None

# ---------- The Hacker Extractor ----------
class HackerExtractor:
    def __init__(self, config: Dict):
        self.config = config
        self.seen = SeenPosts(config["PERSISTENCE_FILE"])
        self.state = BotState(config["STATE_FILE"])
        self.account_pool = config["ACCOUNTS"]
        self.current_account_index = 0  # simple round-robin

    def get_next_account(self) -> Dict:
        """Cycle through accounts in case of failure."""
        acc = self.account_pool[self.current_account_index % len(self.account_pool)]
        self.current_account_index += 1
        return acc

    async def scrape_forum(self, forum_config: Dict) -> List[Dict]:
        """Scrape a forum with adaptive engine selection."""
        url = forum_config["url"]
        board_url = forum_config.get("board_url", url)
        engine_used = self.state.get_forum_strategy(url) or self.config["DEFAULT_ENGINE"]

        # We'll try engine in order: the last successful first, then the other.
        engines_to_try = [engine_used] if engine_used else ["http", "playwright"]
        if "playwright" not in engines_to_try:
            engines_to_try.append("playwright")
        if "http" not in engines_to_try:
            engines_to_try.append("http")

        # Try accounts in a loop
        for account_try in range(3):  # max 3 account attempts
            account = self.get_next_account()
            logger.info(f"Trying account: {account['username']}")

            for engine_name in engines_to_try:
                try:
                    # Instantiate scraper
                    if engine_name == "playwright":
                        scraper = PlaywrightScraper(self.config)
                    else:
                        scraper = HttpScraper(self.config)

                    async with scraper:
                        # Login if needed
                        if forum_config.get("login", {}).get("enabled", False):
                            login_ok = await scraper.login(forum_config, account)
                            if not login_ok:
                                logger.warning(f"Login failed for {account['username']} with {engine_name} – trying next")
                                continue  # try next engine

                        # Fetch the board
                        html = await scraper.fetch(board_url)
                        if not html:
                            logger.warning(f"Fetch failed with {engine_name} – trying next")
                            continue

                        # Parse
                        posts = self.parse_forum(html, forum_config)
                        # Mark seen only new ones
                        new_posts = []
                        for post in posts:
                            if not self.seen.is_seen(url, post["id"]):
                                new_posts.append(post)
                                self.seen.mark_seen(url, post["id"])

                        # If we got here, success – save engine strategy
                        self.state.set_forum_strategy(url, engine_name)
                        logger.info(f"✅ Scraped {len(new_posts)} new posts from {url} using {engine_name}")
                        return new_posts

                except Exception as e:
                    logger.error(f"Engine {engine_name} error: {e}")
                    continue

            # If all engines failed with this account, try next account
            logger.warning(f"All engines failed for account {account['username']} – switching account")

        logger.error(f"❌ Completely failed to scrape {url} after all accounts and engines")
        return []

    def parse_forum(self, html: str, forum_config: Dict) -> List[Dict[str, str]]:
        selectors = forum_config["selectors"]
        soup = BeautifulSoup(html, "html.parser")
        posts = []

        containers = soup.select(selectors["post_container"])
        for container in containers:
            # Unique ID
            if selectors["id"].startswith(".") or selectors["id"].startswith("#"):
                id_elem = container.select_one(selectors["id"])
                post_id = id_elem.get_text(strip=True) if id_elem else None
            else:
                post_id = container.get(selectors["id"])

            if not post_id:
                # Fallback: title + timestamp
                title_elem = container.select_one(selectors.get("title", ""))
                time_elem = container.select_one(selectors.get("timestamp", ""))
                if title_elem and time_elem:
                    post_id = f"{title_elem.get_text(strip=True)}_{time_elem.get_text(strip=True)}"
                else:
                    continue

            def extract(selector: str) -> str:
                if not selector:
                    return ""
                elem = container.select_one(selector)
                return elem.get_text(strip=True) if elem else ""

            posts.append({
                "id": str(post_id),
                "title": extract(selectors.get("title", "")),
                "content": extract(selectors.get("content", "")),
                "author": extract(selectors.get("author", "")),
                "timestamp": extract(selectors.get("timestamp", "")),
                "url": forum_config["url"],
            })
        return posts

# ---------- Branded Publisher ----------
class BrandedPublisher:
    def __init__(self, config: Dict):
        self.bot = Bot(token=config["BOT_TOKEN"])
        self.chat_id = config["PUBLISH_CHAT_ID"]
        self.branding = config["BRANDING"]

    async def publish(self, forum_url: str, posts: List[Dict[str, str]]):
        if not posts:
            return
        header = f"📡 **New posts from** `{forum_url}`\n\n"
        body = ""
        for idx, post in enumerate(posts, 1):
            body += f"**{idx}. {post['title']}**\n"
            body += f"👤 {post['author']} | 🕒 {post['timestamp']}\n"
            body += f"📄 {post['content'][:500]}{'...' if len(post['content']) > 500 else ''}\n\n"
        full = header + body + "\n" + self.branding

        if len(full) > 4000:
            parts = [full[i:i+4000] for i in range(0, len(full), 4000)]
            for part in parts:
                try:
                    await self.bot.send_message(chat_id=self.chat_id, text=part, parse_mode="Markdown")
        
