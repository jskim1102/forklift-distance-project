"""Docker clone portability contracts for Linux, macOS, and Windows hosts."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_shell_entrypoint_is_normalized_and_invoked_through_posix_shell() -> None:
    dockerfile = (ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")

    assert "COPY --chmod=0755 docker-entrypoint.sh /app/docker-entrypoint.sh" in dockerfile
    assert "replace(b'\\r\\n', b'\\n')" in dockerfile
    assert "removeprefix(b'\\xef\\xbb\\xbf')" in dockerfile
    assert 'ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]' in dockerfile


def test_compose_rebuilds_local_app_images_and_waits_for_backend_health() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert compose.count("pull_policy: build") == 2
    assert "http://127.0.0.1:8000/api/health" in compose
    assert "condition: service_healthy" in compose


def test_git_forces_lf_for_shell_scripts() -> None:
    attributes = (ROOT / ".gitattributes").read_text(encoding="utf-8")

    assert "* text=auto eol=lf" in attributes
    assert "*.sh text eol=lf" in attributes


def test_native_dev_runner_syncs_backend_requirements_before_launch() -> None:
    """requirements가 바뀐 기존 venv로 서버를 띄워 런타임 import가 빠지는 회귀를 막는다."""
    dev_script = (ROOT / "dev.sh").read_text(encoding="utf-8")

    install = 'backend/.venv/bin/python -m pip install -r "$req"'
    remove_gui_opencv = 'backend/.venv/bin/python -m pip uninstall -y opencv-python'
    restore_headless = (
        "backend/.venv/bin/python -m pip install --no-deps --force-reinstall "
        "opencv-python-headless==4.13.0.92"
    )
    launch = 'setsid bash -c "cd \'$dir\' && $cmd"'
    assert install in dev_script
    assert dev_script.index(install) < dev_script.index(remove_gui_opencv)
    assert dev_script.index(remove_gui_opencv) < dev_script.index(restore_headless)
    assert dev_script.index(restore_headless) < dev_script.index(launch)
    assert 'sha256sum "$req"' in dev_script
