// GET /api/wavelength/os-options：回傳支援的作業系統選項（靜態清單）。
import { jsonResponse } from "../../utils/http.js";
import { listWavelengthOsOptions } from "../../utils/wavelength.js";

export default defineEventHandler(async () => {
  return jsonResponse({
    os: listWavelengthOsOptions(),
  });
});
