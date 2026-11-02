//! Release-owned numeric encoder. The versioned input contains final, validated
//! values, never Calculation Bundle references or business transformation rules.
use std::{
    env,
    fs::{self, File},
    io::{self, BufReader, Read},
    path::Path,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const MAX_ROWS: u64 = 2_000_000;
const MAX_COLUMNS: u64 = 2_000_000;
const MAX_IMPACTS: u64 = 4096;
const MAX_BYTES: u64 = 32 * 1024 * 1024 * 1024;

fn ensure(ok: bool, message: &str) -> Result<()> {
    if !ok {
        return Err(message.into());
    }
    Ok(())
}
struct Input {
    reader: BufReader<File>,
    rows: usize,
    columns: u64,
    impacts: usize,
    consumed: u64,
}
impl Input {
    fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        ensure(
            file.metadata()?.len() <= MAX_BYTES,
            "numeric input exceeds budget",
        )?;
        let mut reader = BufReader::new(file);
        let mut magic = [0; 8];
        reader.read_exact(&mut magic)?;
        ensure(&magic == b"TGQNUM02", "unsupported numeric input")?;
        let rows = read_u64(&mut reader)?;
        let columns = read_u64(&mut reader)?;
        let impacts = read_u64(&mut reader)?;
        ensure(
            rows > 0 && rows <= MAX_ROWS && columns <= MAX_COLUMNS && impacts <= MAX_IMPACTS,
            "invalid axes",
        )?;
        ensure(
            rows.checked_mul(impacts)
                .and_then(|v| v.checked_mul(8))
                .is_some_and(|v| v <= MAX_BYTES),
            "dense matrix exceeds budget",
        )?;
        Ok(Self {
            reader,
            rows: rows as usize,
            columns,
            impacts: impacts as usize,
            consumed: 32,
        })
    }
    fn row(&mut self) -> Result<(Vec<u64>, Vec<f64>, Vec<f64>)> {
        let count = read_u64(&mut self.reader)?;
        ensure(count <= self.columns, "row exceeds inventory axis")?;
        self.consumed = self
            .consumed
            .checked_add(8 + count * 16 + self.impacts as u64 * 8)
            .ok_or("input size overflow")?;
        ensure(self.consumed <= MAX_BYTES, "input exceeds budget")?;
        let mut columns = Vec::with_capacity(count as usize);
        let mut values = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let col = read_u64(&mut self.reader)?;
            let value = read_f64(&mut self.reader)?;
            ensure(
                col < self.columns && columns.last().is_none_or(|last| *last < col),
                "invalid or repeated column",
            )?;
            ensure(
                value.is_finite() && value != 0.0,
                "inventory value must be finite and nonzero",
            )?;
            columns.push(col);
            values.push(value);
        }
        let mut impacts = Vec::with_capacity(self.impacts);
        for _ in 0..self.impacts {
            let value = read_f64(&mut self.reader)?;
            ensure(value.is_finite(), "nonfinite impact")?;
            impacts.push(value);
        }
        Ok((columns, values, impacts))
    }
    fn end(mut self) -> Result<()> {
        ensure(
            self.reader.read(&mut [0; 1])? == 0,
            "trailing numeric input",
        )
    }
}
fn read_u64(input: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}
fn read_f64(input: &mut impl Read) -> io::Result<f64> {
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes)?;
    Ok(f64::from_le_bytes(bytes))
}
fn build(input: &Path, out: &Path) -> Result<()> {
    let mut source = Input::open(input)?;
    fs::create_dir(out)?;
    let result = (|| -> Result<()> {
        let lci = hdf5::File::create(out.join("lci.h5"))?;
        let columns = lci
            .new_dataset::<u64>()
            .shape(0..)
            .chunk(8192)
            .deflate(3)
            .obj_track_times(false)
            .create("indices")?;
        let values = lci
            .new_dataset::<f64>()
            .shape(0..)
            .chunk(8192)
            .deflate(3)
            .obj_track_times(false)
            .create("values")?;
        let lcia = if source.impacts > 0 {
            Some(hdf5::File::create(out.join("lcia.h5"))?)
        } else {
            None
        };
        let impacts = match &lcia {
            Some(file) => Some(
                file.new_dataset::<f64>()
                    .shape((source.rows, source.impacts))
                    .chunk((1, source.impacts))
                    .deflate(3)
                    .obj_track_times(false)
                    .create("values")?,
            ),
            None => None,
        };
        let mut offsets = vec![0_u64];
        for row in 0..source.rows {
            let (row_columns, row_values, row_impacts) = source.row()?;
            let start = *offsets.last().ok_or("missing offset")? as usize;
            let end = start
                .checked_add(row_columns.len())
                .ok_or("offset overflow")?;
            ensure(
                (end as u64).checked_mul(16).is_some_and(|v| v <= MAX_BYTES),
                "CSR exceeds budget",
            )?;
            if end > start {
                columns.resize(end)?;
                values.resize(end)?;
                columns.write_slice(row_columns.as_slice(), start..end)?;
                values.write_slice(row_values.as_slice(), start..end)?;
            }
            offsets.push(end as u64);
            if let Some(matrix) = &impacts {
                matrix.write_slice(row_impacts.as_slice(), (row, ..))?;
            }
        }
        source.end()?;
        lci.new_dataset_builder()
            .with_data(offsets.as_slice())
            .obj_track_times(false)
            .create("indptr")?;
        lci.flush()?;
        if let Some(file) = lcia {
            file.flush()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(out);
    }
    result?;
    // Reopen the real files; a successful write is not qualification.
    verify(input, out)
}
fn verify(input: &Path, out: &Path) -> Result<()> {
    let mut source = Input::open(input)?;
    let lci = hdf5::File::open(out.join("lci.h5"))?;
    let pointer = lci.dataset("indptr")?;
    let columns = lci.dataset("indices")?;
    let values = lci.dataset("values")?;
    ensure(
        pointer.dtype()?.is::<u64>() && pointer.shape() == [source.rows + 1],
        "invalid CSR offsets type/shape",
    )?;
    ensure(
        columns.dtype()?.is::<u64>() && values.dtype()?.is::<f64>(),
        "invalid CSR numeric types",
    )?;
    let offsets = pointer.read_raw::<u64>()?;
    ensure(offsets[0] == 0, "CSR must start at zero")?;
    let count = offsets[source.rows] as usize;
    ensure(
        columns.shape() == [count] && values.shape() == [count],
        "CSR dimension mismatch",
    )?;
    let impacts = if source.impacts > 0 {
        let matrix = hdf5::File::open(out.join("lcia.h5"))?.dataset("values")?;
        ensure(
            matrix.dtype()?.is::<f64>() && matrix.shape() == [source.rows, source.impacts],
            "invalid LCIA type/shape",
        )?;
        Some(matrix)
    } else {
        ensure(!out.join("lcia.h5").exists(), "unexpected LCIA layer")?;
        None
    };
    for row in 0..source.rows {
        let (expected_columns, expected_values, expected_impacts) = source.row()?;
        let start = offsets[row] as usize;
        let end = offsets[row + 1] as usize;
        ensure(
            end >= start && end - start == expected_columns.len(),
            "CSR row mismatch",
        )?;
        let actual_columns = columns.read_slice_1d::<u64, _>(start..end)?;
        let actual_values = values.read_slice_1d::<f64, _>(start..end)?;
        ensure(
            actual_columns.as_slice() == Some(expected_columns.as_slice())
                && actual_values.as_slice() == Some(expected_values.as_slice()),
            "inventory readback mismatch",
        )?;
        if let Some(matrix) = &impacts {
            ensure(
                matrix.read_slice_1d::<f64, _>((row, ..))?.as_slice()
                    == Some(expected_impacts.as_slice()),
                "LCIA readback mismatch",
            )?;
        }
    }
    source.end()
}
fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().collect();
    if args.len() == 2 && args[1] == "--help" {
        println!(
            "release-result-hdf5 <build|verify> <numeric-input> <output-directory>\nEncodes TGQNUM02 final values; no solver, transport or publication."
        );
        return Ok(());
    }
    ensure(
        args.len() == 4,
        "expected build|verify INPUT OUTPUT; see --help",
    )?;
    match args[1].to_str() {
        Some("build") => build(Path::new(&args[2]), Path::new(&args[3])),
        Some("verify") => verify(Path::new(&args[2]), Path::new(&args[3])),
        _ => Err("unsupported operation".into()),
    }
}
