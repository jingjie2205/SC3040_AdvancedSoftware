"""
The repository's Supabase client is never shared between worker threads.

One HTTP/2 client used by several threads failed against the live project (about one call in six raised
`ReadError`, WinError 10035 on Windows), and the training page loads two or three endpoints at once. These tests
need no network: they check that each thread gets a client of its own, built lazily and once.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.training import repository as repository_module
from app.training.repository import SupabaseTrainingRepository, ThreadLocalClient, create_repository


class FakeClient:
    """Remembers which threads used it."""

    def __init__(self):
        self.threads = set()

    def table(self, name):
        self.threads.add(threading.get_ident())
        return f"table:{name}"


class Factory:
    """Builds fake clients and keeps them, safely, whatever thread asks."""

    def __init__(self):
        self.clients = []
        self._lock = threading.Lock()

    def __call__(self):
        client = FakeClient()
        with self._lock:
            self.clients.append(client)
        return client


def test_nothing_is_built_until_the_client_is_first_used():
    factory = Factory()
    ThreadLocalClient(factory)
    assert factory.clients == []


def test_a_thread_keeps_using_the_client_it_was_given():
    factory = Factory()
    proxy = ThreadLocalClient(factory)
    assert proxy.table("a") == "table:a"
    assert proxy.table("b") == "table:b"
    assert len(factory.clients) == 1


def test_each_thread_gets_its_own_client_and_never_touches_another_threads():
    factory = Factory()
    proxy = ThreadLocalClient(factory)
    everyone_is_here = threading.Barrier(6)  # six threads alive at once, so no thread can inherit a finished one's

    def work(_):
        everyone_is_here.wait()
        for _ in range(20):
            proxy.table("x")

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(work, range(6)))

    assert len(factory.clients) == 6
    assert all(len(client.threads) == 1 for client in factory.clients)  # each was used by one thread only
    assert len({next(iter(client.threads)) for client in factory.clients}) == 6  # and no two share a thread


def test_private_and_special_lookups_do_not_build_a_client():
    factory = Factory()
    proxy = ThreadLocalClient(factory)
    assert not hasattr(proxy, "__wrapped__")
    assert not hasattr(proxy, "_anything")
    assert factory.clients == []


def test_a_factory_that_fails_is_tried_again_on_the_next_use():
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("the database is unreachable")
        return FakeClient()

    proxy = ThreadLocalClient(flaky)
    with pytest.raises(RuntimeError):
        proxy.table("a")
    assert proxy.table("a") == "table:a"


def test_the_real_repository_is_built_on_per_thread_clients(monkeypatch):
    factory = Factory()
    monkeypatch.setattr(repository_module, "get_supabase_admin", factory)
    repo = create_repository()
    assert isinstance(repo, SupabaseTrainingRepository)
    assert isinstance(repo.db, ThreadLocalClient)
    assert factory.clients == []  # building the service at start-up doesn't open a connection
    assert repo.db.table("training_plans") == "table:training_plans"
    assert len(factory.clients) == 1
