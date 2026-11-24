import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },  // 절대경로 임포트 정책
  },
  // tsconfig 의 jsx:"preserve"(Next 용)와 별개로, 테스트에서 page.tsx 를 직접 부르기 위해 JSX 를 변환한다
  oxc: { jsx: { runtime: "automatic" } },
  // 테스트 본문 안에서 페이지 모듈을 처음 불러오는 사례가 있고(protected-routes · deploys-detail-page), 테스트 단계는 변환 캐시가 없는 배포 서버에서도 돈다
  test: { testTimeout: 15_000 },
});
