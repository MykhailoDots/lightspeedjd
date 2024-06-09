import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import utc from "dayjs/plugin/utc";
import dayJsTimezone from "dayjs/plugin/timezone";
import isoWeeksInYear from "dayjs/plugin/isoWeeksInYear";
import isoWeek from "dayjs/plugin/isoWeek";
import weekday from "dayjs/plugin/weekday";
import isLeapYear from "dayjs/plugin/isLeapYear";
import calendar from "dayjs/plugin/calendar";
import dayOfYear from "dayjs/plugin/dayOfYear";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(utc);
dayjs.extend(dayJsTimezone);
dayjs.extend(isBetween);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(isoWeeksInYear);
dayjs.extend(isoWeek);
dayjs.extend(weekday);
dayjs.extend(isLeapYear);
dayjs.extend(calendar);
dayjs.extend(dayOfYear);
dayjs.extend(customParseFormat);

export default dayjs;
