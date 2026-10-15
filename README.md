# portfolio-site

Source for [portfolio.timbacloudpanel.org](https://portfolio.timbacloudpanel.org): a signal-box style control panel for my homelab, with lamps driven by live readings from the platform it runs on.

- **Site:** static HTML/CSS with one small script, served by nginx. No framework, no build step.
- **Live readings:** `deploy/collect-status.sh` runs as a Kubernetes CronJob with read-only, per-object RBAC and writes an allow-listed `status.json` into a ConfigMap. The ConfigMap is mounted into the nginx pod under `/status/`. Host readings and the deploy register come from the deploy watcher on the Proxmox host. The browser never talks to the Kubernetes API.
- **Deploy:** pushing to `main` is picked up by the homelab deploy watcher (a systemd timer), which builds the image, imports it into k3s and rolls it out.

```sh
docker build -t portfolio-site:latest .
kubectl apply -f deploy/k8s.yaml
```
