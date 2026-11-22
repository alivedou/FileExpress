.PHONY: dev test build deploy lint docs migrate seed benchmark release integration e2e coverage

dev:
	npm run dev
test:
	npm run test:unit
coverage:
	npm run test:coverage
integration:
	npm run test:integration
e2e:
	npm run test:e2e
build:
	npm run build
lint:
	npm run typecheck && npm run lint && npm run format:check
docs:
	npm run docs:generate
migrate:
	npx tsx scripts/migrate.ts
seed:
	npx tsx scripts/seed.ts
benchmark:
	npx tsx scripts/benchmark.ts && k6 run test/performance/generated.k6.js
release:
	npx tsx scripts/release.ts $(VERSION)
deploy:
	helm upgrade --install fileexpress helm/fileexpress --namespace fileexpress-dev --create-namespace --values helm/fileexpress/values-dev.yaml
