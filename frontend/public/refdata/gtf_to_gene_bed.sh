#!/usr/bin/env bash

set -euo pipefail

for tool in curl awk sort gzip; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "ERROR: Required command not found: ${tool}" >&2
        exit 1
    fi
done

for assembly in hg38 hg19 mm10 mm9; do
    case "${assembly}" in
        hg38)
            version="v50"
            url="https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_50/gencode.v50.annotation.gtf.gz"
            ;;
        hg19)
            version="v19"
            url="https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_19/gencode.v19.annotation.gtf.gz"
            ;;
        mm10)
            version="vM25"
            url="https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M25/gencode.vM25.annotation.gtf.gz"
            ;;
        mm9)
            version="vM1"
            url="https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M1/gencode.vM1.annotation.gtf.gz"
            ;;
        *)
            echo "ERROR: Unsupported assembly: ${assembly}" >&2
            exit 1
            ;;
    esac

    filename="gencode.${version}.annotation.gtf.gz"
    current_gtf="${assembly}/${filename}"
    legacy_gtf="${assembly}/${filename}"
    bed="${assembly}.gencode.${version}.genes.bed"

    echo "Processing ${assembly} using GENCODE ${version}"

    # Reuse files from the previous directory layout when present.
    if [[ -s "${current_gtf}" ]] && gzip -t "${current_gtf}" 2>/dev/null; then
        gtf="${current_gtf}"
        echo "Using existing file: ${gtf}"
    elif [[ -s "${legacy_gtf}" ]] && gzip -t "${legacy_gtf}" 2>/dev/null; then
        gtf="${legacy_gtf}"
        echo "Using existing file: ${gtf}"
    else
        gtf="${current_gtf}"

        echo "Downloading: ${gtf}"

        #curl --fail --location --retry 3 --retry-delay 5 --output "${gtf}" "${url}"

        gzip -t "${gtf}"
    fi

    echo "Creating gene-level BED6: ${bed}"

    gzip -dc "${gtf}" |
        awk -F '\t' '
            BEGIN {
                OFS = "\t"
            }

            function clean_attribute(value) {
                sub(/^[[:space:]]+/, "", value)
                sub(/[[:space:]]+$/, "", value)
                sub(/^[^[:space:]]+[[:space:]]+/, "", value)
                gsub(/^"/, "", value)
                gsub(/"$/, "", value)
                return value
            }

            $0 !~ /^#/ && $3 == "gene" {
                gene_id = ""
                gene_name = ""
                gene_type = ""

                attribute_count = split($9, attributes, ";")

                for (i = 1; i <= attribute_count; i++) {
                    attribute = attributes[i]
                    sub(/^[[:space:]]+/, "", attribute)

                    if (attribute ~ /^gene_id[[:space:]]/) {
                        gene_id = clean_attribute(attribute)
                    } else if (attribute ~ /^gene_name[[:space:]]/) {
                        gene_name = clean_attribute(attribute)
                    } else if (attribute ~ /^gene_type[[:space:]]/) {
                        gene_type = clean_attribute(attribute)
                    } else if (
                        gene_type == "" &&
                        attribute ~ /^gene_biotype[[:space:]]/
                    ) {
                        gene_type = clean_attribute(attribute)
                    }
                }

                if (gene_name == "") {
                    gene_name = gene_id
                }

                if (gene_type == "") {
                    gene_type = "unknown"
                }

                # GTF is 1-based closed; BED is 0-based half-open.
                print $1, $4 - 1, $5, \
                      gene_name "|" gene_id "|" gene_type, \
                      0, $7
            }
        ' |
        LC_ALL=C sort -k1,1 -k2,2n -k3,3n > "${bed}"

    if [[ ! -s "${bed}" ]]; then
        echo "ERROR: No BED records were produced for ${assembly}" >&2
        exit 1
    fi

    record_count=$(wc -l < "${bed}" | tr -d " ")

    echo "Created: ${bed}"
    echo "Genes: ${record_count}"
    echo
done