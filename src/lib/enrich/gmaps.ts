import type { IncomingRow } from "./insert-rows";

// One GMaps Scraper chunk, exactly as the client's Clay webhook table received it:
//   { taskId, originalTaskId?, extra: { client, keyword, city, state, category, scrape_queue_id },
//     postbackData: { tasks: [ { id, data, result: [ { items: [ …up to 25 places… ] } ] } ] } }
// The places are DataForSEO Google Maps items. They are mapped the way Clay's
// "Write to Other Table" mapped them into the client's Companies table.

type Item = {
  place_id?: string;
  title?: string;
  url?: string;
  domain?: string;
  address?: string;
  phone?: string;
  category?: string;
  category_ids?: string[];
  additional_categories?: string[];
  address_info?: { city?: string; region?: string };
};

interface Postback {
  taskId?: string;
  originalTaskId?: string;
  extra?: Record<string, unknown>;
  postbackData?: { tasks?: { result?: { items?: Item[] }[] }[] };
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function rowsFromPostback(body: unknown, clientTag: string) {
  const pb = (body ?? {}) as Postback;
  const extra = pb.extra ?? {};
  // Clay only wrote rows when the search's city, state and category came with
  // the chunk. The client comes from the X-Client-Tag header here, not from
  // extra.client, which the scraper can leave empty.
  const missing = ["city", "state", "category"].filter((k) => !str(extra[k]).trim()).map((k) => `extra.${k}`);
  // Clay read tasks[0].result[0] only; every chunk the scraper sends has one,
  // so reading them all is the same today and safer if that ever changes.
  const items = (pb.postbackData?.tasks ?? []).flatMap((t) => t?.result ?? []).flatMap((r) => r?.items ?? []);
  const rows: IncomingRow[] = items.map((it) => ({
    inputs: {
      company: it.title,
      place_id: it.place_id,
      website: it.url,
      domain: it.domain,
      address: it.address,
      phone: it.phone,
      category: it.category,
      sub_category: it.category_ids?.[0],
      additional_category: it.additional_categories?.[0],
      actual_city: it.address_info?.city,
      actual_state: it.address_info?.region,
      call_city: str(extra.city),
      call_state: str(extra.state),
      call_category: str(extra.category),
      client_tag: clientTag,
    },
  }));
  return {
    rows,
    missing,
    taskId: str(pb.taskId) || null,
    meta: {
      task_id: str(pb.originalTaskId || pb.taskId) || null,
      keyword: str(extra.keyword) || null,
      city: str(extra.city) || null,
      state: str(extra.state) || null,
      category: str(extra.category) || null,
      scrape_queue_id: str(extra.scrape_queue_id) || null,
    },
  };
}
