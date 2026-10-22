# The backup image (ADR-090): the nightly logical backup, run by a Railway cron service inside the
# project. Its entrypoint runs one backup and exits; nothing in it listens.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.
#
# What it holds, each pinned and checked:
#   pg_dump, pg_restore, psql 18.6   the PostgreSQL image's own client programs, the same build
#                                    as the database it dumps and the restore drill's image
#   age v1.3.2                       the release's SHA-256 (ADR-173), checked by BuildKit
#   AWS CLI 1.46.1                   from PyPI with the SHA-256 of every wheel it needs
#                                    (infra/backup/requirements.txt, pip --require-hashes)
#   infra/backup/*.sh                this repository's scripts, read-only, run by a non-root user
# It holds no credential: Railway sets the backup service's variables at run time.

# age v1.3.2 (FiloSottile/age release asset), SHA-256 computed on 2026-10-19. BuildKit refuses the
# download if the checksum differs, so no layer is built from a changed file.
FROM scratch AS age-release
ADD --checksum=sha256:cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 \
    https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz /age.tar.gz

# postgres:18.6-bookworm, index digest read from Docker Hub on 2026-10-17 (ci.yml, restore-drill.yml).
FROM postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
# Python for the AWS CLI only; it is installed into its own virtual environment from hash-pinned
# wheels, with no build step and no dependency resolution at install time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --home-dir /nonexistent \
         --shell /usr/sbin/nologin rampsmith-backup
COPY infra/backup/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/awscli \
    && /opt/awscli/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps \
         -r /tmp/requirements.txt \
    && ln -s /opt/awscli/bin/aws /usr/local/bin/aws \
    && rm -f /tmp/requirements.txt
RUN --mount=type=bind,from=age-release,source=/age.tar.gz,target=/tmp/age.tar.gz \
    tar -xzf /tmp/age.tar.gz -C /usr/local/bin --strip-components=1 age/age
# Fail the build, not the first nightly run, if a tool does not start.
RUN age --version && aws --version && pg_dump --version && psql --version
COPY --chmod=0755 infra/backup/backup.sh infra/backup/entrypoint.sh /opt/rampsmith/backup/
# 0755, not 0644: BuildKit applies --chmod to the directories it creates, and a directory without the
# execute bit cannot be entered. Neither mode is writable by the user that runs them.
COPY --chmod=0755 infra/backup/lib/common.sh infra/backup/lib/s3.sh /opt/rampsmith/backup/lib/

# The PostgreSQL image starts a server and keeps a data volume; this one only runs the entrypoint.
ENV PGBIN=/usr/lib/postgresql/18/bin \
    HOME=/tmp \
    AWS_EC2_METADATA_DISABLED=true
STOPSIGNAL SIGTERM
USER 10001:10001
ENTRYPOINT ["/opt/rampsmith/backup/entrypoint.sh"]
CMD []
