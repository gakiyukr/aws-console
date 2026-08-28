// GET /api/ec2/os-options：回傳一般 EC2 部署支援的作業系統。
import { jsonResponse } from "../../utils/http.js";
import { listWavelengthOsOptions } from "../../utils/wavelength.js";

export default defineEventHandler(() => jsonResponse({ os: listWavelengthOsOptions() }));
