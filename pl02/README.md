# PL02 — code

Files for the PL02 guide (`../MEI.CDN-2627-PL02.md` / `../MEI.CDN-2627-PL02-EN.md`).

- `app/` — the PL01 app (`app.js`, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`). One change from PL01: `GET /` also returns `version`, read from the `APP_VERSION` environment variable. The `Dockerfile` is unchanged.
- `k8s/` — Kubernetes manifests, one file per object:
  - `app-deployment.yaml`, `app-service.yaml` — the app (section 3); `ingress.yaml` — section 4.
  - `db-config.yaml`, `db-secret.yaml`, `db-pvc.yaml`, `db-deployment.yaml`, `db-service.yaml` — Postgres (section 5).
  - `solucao/app-deployment-s5.yaml`, `solucao/app-deployment-s6.yaml` — `app-deployment.yaml` as it should look after the edits in sections 5 and 6 (compare with `diff`).
- `registries.yaml` — k3d `--registry-config` file: the cluster nodes pull `docker.io` images through `https://mirror.gcr.io`.

Run everything from the folder that contains `app/`, `k8s/` and `registries.yaml`.
