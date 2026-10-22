# The backup image (ADR-251, ADR-258): the nightly logical backup, run by a Railway cron service
# inside the project. Its entrypoint runs one backup and exits; nothing in it listens.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.
#
# What it holds, each pinned and checked:
#   debian:bookworm-slim             the slim Debian base, not the PostgreSQL server image: no server
#                                    binaries, no gosu (whose Go runtime failed the release's
#                                    vulnerability gate), security updates applied at build time
#   pg_dump, pg_restore, psql 18.x   PGDG's postgresql-client-18 only (apt.postgresql.org, signed
#                                    with the repository key whose fingerprint is checked below);
#                                    the same major as the database it dumps and the restore drill
#   openssl                          signs the metadata object (Ed25519, ADR-256)
#   age v1.3.2                       the release's SHA-256 (ADR-173), checked by BuildKit; v1.3.2 is the
#                                    newest tag of FiloSottile/age (checked 2026-10-22)
#   AWS CLI 1.46.1                   from PyPI with the SHA-256 of every wheel it needs
#                                    (infra/backup/requirements.txt, pip --require-hashes)
#   infra/backup/*.sh                this repository's scripts, read-only, run by a non-root user
# It holds no credential: Railway sets the backup service's variables at run time.

# age v1.3.2 (FiloSottile/age release asset), SHA-256 computed on 2026-10-19. BuildKit refuses the
# download if the checksum differs, so no layer is built from a changed file.
FROM scratch AS age-release
ADD --checksum=sha256:cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 \
    https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz /age.tar.gz

# debian:bookworm-slim, index digest read from the docker-library/repo-info record of the official
# image on 2026-10-22 (rebuilt 2026-10-20). Renovate proposes newer digests.
# --- stage: the PGDG repository key -----------------------------------------------------------------
# apt.postgresql.org signs its repository with one key. It is fetched by its full fingerprint, which
# gpg checks against the key it receives (the PostgreSQL project's published fingerprint, and the
# one the official postgres image uses), in a stage of its own so that gnupg is not in the final image.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS pgdg-key
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates dirmngr gnupg; \
    key='B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys "$key"; \
    gpg --batch --export --armor "$key" >/pgdg.asc; \
    test "$(gpg --batch --show-keys --with-colons /pgdg.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "$key"

# --- stage: the image -------------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=pgdg-key /pgdg.asc /usr/local/share/keyrings/postgres.gpg.asc
# Python for the AWS CLI only (installed below into its own virtual environment from hash-pinned
# wheels); the PostgreSQL 18 client programs from PGDG; openssl for the signature; security updates.
RUN set -eux; \
    echo "deb [signed-by=/usr/local/share/keyrings/postgres.gpg.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main 18" \
      >/etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get -y --no-install-recommends -o Dpkg::Options::=--force-confold upgrade; \
    apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client-18 python3 python3-venv; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --system --uid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin rampsmith-backup
COPY infra/backup/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/awscli \
    && /opt/awscli/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps \
         -r /tmp/requirements.txt \
    && /opt/awscli/bin/pip uninstall --yes setuptools pkg_resources \
    && ln -s /opt/awscli/bin/aws /usr/local/bin/aws \
    && rm -f /tmp/requirements.txt
RUN --mount=type=bind,from=age-release,source=/age.tar.gz,target=/tmp/age.tar.gz \
    tar -xzf /tmp/age.tar.gz -C /usr/local/bin --strip-components=1 age/age
# Fail the build, not the first nightly run, if a tool does not start.
RUN age --version && aws --version && pg_dump --version && psql --version && openssl version \
    && test ! -e /usr/lib/postgresql/18/bin/postgres && ! command -v gosu
COPY --chmod=0755 infra/backup/backup.sh infra/backup/entrypoint.sh /opt/rampsmith/backup/
# 0755, not 0644: BuildKit applies --chmod to the directories it creates, and a directory without the
# execute bit cannot be entered. Neither mode is writable by the user that runs them.
COPY --chmod=0755 infra/backup/lib/common.sh infra/backup/lib/s3.sh infra/backup/lib/sign.sh /opt/rampsmith/backup/lib/

# No server and no data volume: this image only runs the entrypoint.
ENV PGBIN=/usr/lib/postgresql/18/bin \
    HOME=/tmp \
    AWS_EC2_METADATA_DISABLED=true
STOPSIGNAL SIGTERM
USER 10001:10001
ENTRYPOINT ["/opt/rampsmith/backup/entrypoint.sh"]
CMD []
