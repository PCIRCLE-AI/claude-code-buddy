"""Basic tests for MeMesh Python SDK (no server required)."""

from memesh import MeMesh, Entity, RememberResult, __version__


def test_version():
    assert __version__ == "3.0.0b1"


def test_memesh_init():
    m = MeMesh()
    assert m.base_url == "http://127.0.0.1:3737"
    m.close()


def test_memesh_custom_host():
    m = MeMesh(host="192.168.1.1", port=4000)
    assert m.base_url == "http://192.168.1.1:4000"
    m.close()


def test_memesh_context_manager():
    with MeMesh() as m:
        assert m.base_url == "http://127.0.0.1:3737"


def test_entity_dataclass():
    e = Entity(id=1, name="test", type="note", created_at="2026-01-01")
    assert e.name == "test"
    assert e.observations == []
    assert e.archived is None
