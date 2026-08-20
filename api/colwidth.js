// pandoc Lua filter: size table columns proportionally to their content.
// pandoc otherwise emits equal-width columns for every table, which forces
// manual column resizing after download. This measures each column's widest
// cell (via stringify length) and sets the colspec widths to match.
module.exports = `function Table(tbl)
  local ncols = #tbl.colspecs
  if ncols < 2 then return tbl end

  local widths = {}
  for i = 1, ncols do widths[i] = 0 end

  local function measure(row)
    for j, cell in ipairs(row.cells) do
      local len = #pandoc.utils.stringify(cell.contents)
      local span = cell.col_span or 1
      local each = math.floor(len / span)
      for k = 0, span - 1 do
        local col = j + k
        if col <= ncols and each > widths[col] then widths[col] = each end
      end
    end
  end

  local function rows(list)
    for _, row in ipairs(list or {}) do measure(row) end
  end

  rows(tbl.head.rows)
  for _, b in ipairs(tbl.bodies) do
    rows(b.head)
    rows(b.body)
  end
  if tbl.foot and tbl.foot.rows then rows(tbl.foot.rows) end

  local total = 0
  for i = 1, ncols do
    if widths[i] < 1 then widths[i] = 1 end
    total = total + widths[i]
  end

  for i = 1, ncols do
    tbl.colspecs[i][2] = widths[i] / total
  end
  return tbl
end
`;
