import { getDatabase } from "@/lib/db";
import { temperatureUploadHandler } from "@/lib/temperature/http";

export const POST = temperatureUploadHandler(getDatabase);
