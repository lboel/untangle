# Untangle local infrastructure (Managed Local)

This optional Compose setup starts Qdrant and Ollama in Untangle's Managed Local
mode (`spec.md` §3.1): named persistent volumes, health checks, loopback-only bindings
and the `dev.untangle.managed=true` ownership label. Configurations pointing at external
endpoints (`spec.md` §3.2) do not need it.

## Ports

| Service | Host port | Container port | Purpose |
|---|---|---|---|
| Qdrant | `16333` | `6333` | REST API |
| Qdrant | `16334` | `6334` | gRPC API |
| Managed Ollama | `11435` | `11434` | Embedding API |

The managed host port 11435 preserves a native Ollama service on 11434. Without an
explicit endpoint override, detection checks `http://127.0.0.1:11434` before the
managed endpoint. Confirmed guided setup selects its owned managed endpoints explicitly.

## Start

```bash
docker compose -f docker/docker-compose.yml up -d
```

## Status and logs

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f
```

## Stop and restart while retaining data

```bash
docker compose -f docker/docker-compose.yml stop
docker compose -f docker/docker-compose.yml start
```

## Reset: delete containers and volumes

The following is destructive and permanently removes the named
`untangle_qdrant_storage` and `untangle_ollama_models` volumes:

```bash
docker compose -f docker/docker-compose.yml down -v
```

Without `-v`, `down` removes containers but retains volumes.

## Identify managed containers

```bash
docker ps --filter "label=dev.untangle.managed=true"
```

## Image versions

Versions are pinned, without `latest` tags, for reproducible indexes/tests:

- `qdrant/qdrant:v1.12.1`
- `ollama/ollama:0.5.4`

An upgrade is an explicit file change, not automatic drift. Document the reset
procedure and check collection-schema compatibility (`architecture.md` §26.2,
`_vN` suffix) before upgrading.
