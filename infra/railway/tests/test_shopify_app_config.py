"""`shopify.app.toml` declares the webhook subscriptions the listener serves (ADR-088).

Before this test nothing subscribed the app to any topic: the intake, the worker and the
compliance handlers were all built and Shopify would never have called them (re-audit of the
webhook code, 22 Oct 2026). The schema checked here is the one Shopify CLI 4.9.4 validates
(`@shopify/cli` on registry.npmjs.org, the app config webhook module): `[webhooks]
api_version`, and `[[webhooks.subscriptions]]` with `topics` or `compliance_topics`, and `uri`.
"""

from __future__ import annotations

import os
import re
import tomllib
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
LISTENER_PATH = "/webhooks/shopify"
COMPLIANCE = {"customers/data_request", "customers/redact", "shop/redact"}
# Every topic `crates/api/src/webhooks.rs` accepts.
ACCEPTED = COMPLIANCE | {"app/uninstalled", "shop/update"}
# Shopify CLI's compliance enum, and the topic shape it accepts.
TOPIC = re.compile(r"[a-z_]+(/[a-z_]+)+")


def config_files() -> list[Path]:
    """`SHOPIFY_APP_CONFIG` (deploy.yml checks the file it is about to deploy), otherwise
    `shopify.app.toml` and every per-environment file `shopify app config link` wrote
    (`shopify.app.<env>.toml`, which is what `shopify app deploy --config <env>` pushes: a file
    made by `config link` starts without the subscriptions)."""
    named = os.environ.get("SHOPIFY_APP_CONFIG")
    if named:
        return [ROOT / named]
    return sorted(ROOT.glob("shopify.app*.toml"))


class WebhookSubscriptions(unittest.TestCase):
    def setUp(self) -> None:
        paths = config_files()
        self.assertTrue(paths, "no shopify.app*.toml found")
        self.path = paths[0]
        self.paths = paths
        self.app = tomllib.loads(self.path.read_text(encoding="utf-8"))
        self.webhooks = self.app["webhooks"]
        self.subscriptions = self.webhooks["subscriptions"]

    def test_every_app_config_file_declares_subscriptions(self) -> None:
        for path in self.paths:
            webhooks = tomllib.loads(path.read_text(encoding="utf-8")).get("webhooks", {})
            self.assertTrue(webhooks.get("subscriptions"), f"{path.name} has no subscriptions")
            self.assertEqual(webhooks.get("api_version"), "2026-10", path.name)

    def test_api_version_is_the_pinned_admin_api_version(self) -> None:
        self.assertEqual(self.webhooks["api_version"], "2026-10")

    def test_the_legacy_privacy_table_is_not_used_with_compliance_topics(self) -> None:
        # Shopify CLI: "The privacy_compliance section can't be used if there are
        # subscriptions including compliance_topics".
        self.assertNotIn("privacy_compliance", self.webhooks)

    def test_each_subscription_has_topics_or_compliance_topics_and_a_uri(self) -> None:
        for sub in self.subscriptions:
            self.assertTrue(sub.get("topics") or sub.get("compliance_topics"), sub)
            self.assertIn("uri", sub)
            self.assertLessEqual(set(sub), {"topics", "compliance_topics", "uri"}, sub)

    def test_all_three_compliance_topics_are_subscribed_exactly_once(self) -> None:
        declared = [t for s in self.subscriptions for t in s.get("compliance_topics", [])]
        self.assertEqual(sorted(declared), sorted(COMPLIANCE))

    def test_app_topics_are_the_uninstall_and_the_shop_update(self) -> None:
        declared = [t for s in self.subscriptions for t in s.get("topics", [])]
        self.assertEqual(sorted(declared), ["app/uninstalled", "shop/update"])
        for topic in declared:
            self.assertRegex(topic, TOPIC)

    def test_no_topic_is_subscribed_that_the_listener_drops(self) -> None:
        declared = {
            t
            for s in self.subscriptions
            for t in s.get("topics", []) + s.get("compliance_topics", [])
        }
        self.assertLessEqual(declared, ACCEPTED)
        self.assertEqual(declared, ACCEPTED, "an accepted topic has no subscription")

    def test_every_subscription_posts_to_the_listener_path_over_https(self) -> None:
        hosts = set()
        for sub in self.subscriptions:
            uri = urlparse(sub["uri"])
            self.assertEqual(uri.scheme, "https", sub["uri"])
            self.assertEqual(uri.path, LISTENER_PATH, sub["uri"])
            self.assertFalse(uri.query or uri.fragment, sub["uri"])
            hosts.add(uri.hostname)
        self.assertEqual(len(hosts), 1, "subscriptions name different hosts")
        # Shopify CLI rejects two subscriptions with the same topic and uri.
        keys = [(t, s["uri"]) for s in self.subscriptions for t in s.get("topics", [])]
        self.assertEqual(len(keys), len(set(keys)))

    def test_the_host_is_not_the_application_host(self) -> None:
        # The webhook host reaches the listener only (ADR-182); `application_url` is `web`.
        host = urlparse(self.subscriptions[0]["uri"]).hostname
        self.assertNotEqual(host, urlparse(self.app["application_url"]).hostname)

    def test_the_host_matches_the_deploy_environment_when_one_is_given(self) -> None:
        wanted = os.environ.get("RAMPSMITH_WEBHOOK_HOST", "")
        if not wanted:
            self.skipTest(
                "RAMPSMITH_WEBHOOK_HOST is not set (LAUNCH.md C row 10); deploy.yml runs this "
                "test with it before `shopify app deploy` (LAUNCH.md E)"
            )
        for sub in self.subscriptions:
            self.assertEqual(urlparse(sub["uri"]).hostname, wanted)


# PLAN §14 "Access scopes": every scope the app may request, each justified there and in
# listing/shopify-app-store/reviewer-instructions.md. App Review requirement 3.2 asks for no more.
PLAN_14_SCOPES = {
    "read_products",
    "write_products",
    "read_files",
    "write_files",
    "read_themes",
    "read_content",
    "write_content",
    "read_online_store_navigation",
    "write_online_store_navigation",
    "read_locales",
}


class AppReviewConfiguration(unittest.TestCase):
    """The App Review checklist items that live in `shopify.app*.toml` (PLAN §14)."""

    def setUp(self) -> None:
        self.apps = {p.name: tomllib.loads(p.read_text(encoding="utf-8")) for p in config_files()}
        self.assertTrue(self.apps, "no shopify.app*.toml found")

    def test_the_scopes_are_exactly_the_ones_the_plan_justifies(self) -> None:
        for name, app in self.apps.items():
            scopes = {s.strip() for s in app["access_scopes"]["scopes"].split(",")}
            self.assertEqual(scopes, PLAN_14_SCOPES, name)

    def test_no_theme_write_and_no_customer_or_order_scope(self) -> None:
        for name, app in self.apps.items():
            scopes = {s.strip() for s in app["access_scopes"]["scopes"].split(",")}
            self.assertNotIn("write_themes", scopes, name)
            self.assertFalse(
                [s for s in scopes if "customer" in s or "order" in s], f"{name}: {scopes}"
            )

    def test_the_app_is_embedded_and_installs_through_shopify(self) -> None:
        for name, app in self.apps.items():
            self.assertIs(app["embedded"], True, name)
            self.assertIs(app["access_scopes"]["use_legacy_install_flow"], False, name)


if __name__ == "__main__":
    unittest.main()
