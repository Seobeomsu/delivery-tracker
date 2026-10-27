import { type Logger } from "winston";
import { JSDOM } from "jsdom";
import {
  Carrier,
  type CarrierTrackInput,
  type TrackInfo,
  type TrackEvent,
  TrackEventStatusCode,
} from "../../core";
import { rootLogger } from "../../logger";
import { DateTime } from "luxon";
import { type CarrierUpstreamFetcher } from "../../carrier-upstream-fetcher/CarrierUpstreamFetcher";
import { BadRequestError, NotFoundError } from "../../core/errors";

const carrierLogger = rootLogger.child({
  carrierId: "jp.japanpost",
});

/**
 * Japan Post (日本郵便). One lookup covers ゆうパック, レターパック, ゆうパケット,
 * クリックポスト, 書留 and international mail handled by Japan Post.
 */
class JapanPost extends Carrier {
  readonly carrierId = "jp.japanpost";

  public async track(input: CarrierTrackInput): Promise<TrackInfo> {
    return await new JapanPostTrackScraper(
      this.upstreamFetcher,
      input.trackingNumber
    ).track();
  }
}

class JapanPostTrackScraper {
  private readonly logger: Logger;

  constructor(
    readonly upstreamFetcher: CarrierUpstreamFetcher,
    readonly trackingNumber: string
  ) {
    this.logger = carrierLogger.child({ trackingNumber });
  }

  public async track(): Promise<TrackInfo> {
    const queryString = new URLSearchParams({
      reqCodeNo1: this.trackingNumber.replace(/-/g, ""),
      searchKind: "S002",
      locale: "ja",
    }).toString();
    const response = await this.upstreamFetcher.fetch(
      `https://trackings.post.japanpost.jp/services/srv/search/direct?${queryString}`
    );
    const traceResponseHtmlText = await response.text();
    this.logger.debug("traceResponseHtmlText", {
      html: traceResponseHtmlText,
    });

    const dom = new JSDOM(traceResponseHtmlText);
    const { document } = dom.window;

    const historyTable = document.querySelector('table[summary="履歴情報"]');
    if (historyTable === null) {
      const message =
        document
          .querySelector('table[summary="照会結果"] td.txt_l')
          ?.textContent?.replace(/\s+/g, " ")
          ?.trim() ?? null;
      if (message === null || message.includes("見つかりません")) {
        throw new NotFoundError(message ?? undefined);
      }
      throw new BadRequestError(message);
    }

    // Each event spans two rows: [date, status, detail, office, prefecture] and [postal code].
    const events: TrackEvent[] = [];
    for (const tr of historyTable.querySelectorAll("tr")) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 5) {
        continue;
      }
      events.push(this.parseEvent(tds));
    }

    return {
      events,
      sender: null,
      recipient: null,
      carrierSpecificData: new Map(),
    };
  }

  private parseEvent(tds: NodeListOf<HTMLTableCellElement>): TrackEvent {
    const text = (index: number): string | null => {
      const value = tds[index].textContent?.replace(/\s+/g, " ")?.trim();
      return value === undefined || value === "" ? null : value;
    };
    const time = text(0);
    const status = text(1);
    const detail = text(2);
    const office = text(3);
    const prefecture = text(4);

    return {
      status: {
        code: this.parseStatusCode(status),
        name: status,
        carrierSpecificData: new Map(),
      },
      time: this.parseTime(time),
      location: {
        name: office,
        countryCode: "JP",
        postalCode: null,
        carrierSpecificData: new Map(),
      },
      contact: null,
      description: [office, status, detail, prefecture]
        .filter((it) => it !== null)
        .join(" - "),
      carrierSpecificData: new Map(),
    };
  }

  private parseStatusCode(text: string | null): TrackEventStatusCode {
    const status = text ?? "";
    if (
      status.includes("お届け済み") ||
      status.includes("お渡し") ||
      status.includes("配達完了")
    ) {
      return TrackEventStatusCode.Delivered;
    }
    if (status.includes("不在") || status.includes("持ち戻り")) {
      return TrackEventStatusCode.AttemptFail;
    }
    if (status.includes("持ち出し")) {
      return TrackEventStatusCode.OutForDelivery;
    }
    if (status.includes("保管")) {
      return TrackEventStatusCode.AvailableForPickup;
    }
    if (status.includes("返送") || status.includes("返還")) {
      return TrackEventStatusCode.Exception;
    }
    if (status.includes("引受")) {
      return TrackEventStatusCode.AtPickup;
    }
    if (
      status.includes("到着") ||
      status.includes("通過") ||
      status.includes("発送") ||
      status.includes("中継")
    ) {
      return TrackEventStatusCode.InTransit;
    }

    this.logger.warn("Unexpected status code", {
      text,
    });
    return TrackEventStatusCode.Unknown;
  }

  private parseTime(time: string | null): DateTime | null {
    if (time === null) {
      return null;
    }
    let result = DateTime.fromFormat(time, "yyyy/MM/dd HH:mm", {
      zone: "Asia/Tokyo",
    });
    if (!result.isValid) {
      // Some events have a date only (e.g. 保管).
      result = DateTime.fromFormat(time, "yyyy/MM/dd", { zone: "Asia/Tokyo" });
    }
    if (!result.isValid) {
      this.logger.warn("time parse error", {
        inputTime: time,
        invalidReason: result.invalidReason,
      });
    }
    return result;
  }
}

export { JapanPost };
