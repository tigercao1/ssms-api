import { Test } from '@nestjs/testing';
import { ReferenceDataController } from './reference-data.controller';
import { SeasonsService } from '../seasons/seasons.service';
import { ReferenceDataService } from './reference-data.service';

describe('ReferenceDataController', () => {
  let controller: ReferenceDataController;
  const service = {
    getTeachingLocations: jest.fn(),
    getLanguages: jest.fn(),
    getCourseLevelsOffered: jest.fn(),
    getExamPreparations: jest.fn(),
  };
  const seasons = { list: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ReferenceDataController],
      providers: [
        { provide: ReferenceDataService, useValue: service },
        { provide: SeasonsService, useValue: seasons },
      ],
    }).compile();
    controller = moduleRef.get(ReferenceDataController);
  });

  it('delegates teaching-locations to the service', async () => {
    const rows = [
      { id: '1', key: 'loc.whistler', name: 'Whistler', sortOrder: 1 },
    ];
    service.getTeachingLocations.mockResolvedValue(rows);
    await expect(controller.teachingLocations()).resolves.toBe(rows);
    expect(service.getTeachingLocations).toHaveBeenCalledTimes(1);
  });

  it('delegates languages to the service', async () => {
    service.getLanguages.mockResolvedValue([]);
    await controller.languages();
    expect(service.getLanguages).toHaveBeenCalledTimes(1);
  });

  it('delegates course-levels-offered to the service', async () => {
    service.getCourseLevelsOffered.mockResolvedValue([]);
    await controller.courseLevelsOffered();
    expect(service.getCourseLevelsOffered).toHaveBeenCalledTimes(1);
  });

  it('delegates exam-preparations to the service', async () => {
    service.getExamPreparations.mockResolvedValue([]);
    await controller.examPreparations();
    expect(service.getExamPreparations).toHaveBeenCalledTimes(1);
  });

  it('delegates seasons to the seasons service', async () => {
    const rows = [
      {
        key: '2026/27',
        startsOn: '2026-11-01',
        endsOn: '2027-04-30',
        isCurrent: true,
      },
    ];
    seasons.list.mockResolvedValue(rows);
    await expect(controller.seasonList()).resolves.toBe(rows);
  });
});
