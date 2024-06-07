import { parse } from "csv-parse/sync";

const parseCsv = async (
  fileName: string
): Promise<OrganizationUserImport[]> => {
  // read csv file
  const csv = fs.readFileSync(fileName, "utf8");
  const parsedCsv = parse(csv, {
    columns: true,
    skip_empty_lines: true,
  });

  console.log(JSON.stringify(parsedCsv, null, 2));

  return parsedCsv;
};

const organizationUsersToImport: OrganizationUserImport[] = await parseCsv(
  fileName
);

console.log("Hello via Bun!");
