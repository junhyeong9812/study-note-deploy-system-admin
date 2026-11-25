/** 화면(src/app)이 주소의 화면 상태를 읽는 길 — src/app 은 기능의 lib 를 값으로 임포트하지 않는다(screen-data-imports.test), 그래서 ui/ 를 거친다. */
import { parseResourcesViewState, type ResourcesViewState } from "@/features/resources/lib/resources-query";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export function resourcesViewStateOf(input: SearchParamsInput): ResourcesViewState {
  return parseResourcesViewState(input);
}
